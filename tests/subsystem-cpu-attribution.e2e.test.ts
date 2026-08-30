import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const originalEnv = {
	BOBBIT_CPU_DIAG: process.env.BOBBIT_CPU_DIAG,
	BOBBIT_CPU_DIAG_FLUSH_MS: process.env.BOBBIT_CPU_DIAG_FLUSH_MS,
	BOBBIT_CPU_DIAG_JSONL: process.env.BOBBIT_CPU_DIAG_JSONL,
	BOBBIT_TEST_NO_PUSH: process.env.BOBBIT_TEST_NO_PUSH,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-subsystem-cpu-"));
const diagFile = path.join(tmpRoot, "cpu.jsonl");
process.env.BOBBIT_CPU_DIAG = "1";
process.env.BOBBIT_CPU_DIAG_FLUSH_MS = "60000";
process.env.BOBBIT_CPU_DIAG_JSONL = diagFile;
process.env.BOBBIT_TEST_NO_PUSH = "1";

function restoreEnv(): void {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function flushSnapshot(reason: string): Promise<any> {
	const { getCpuDiagnostics } = await import("../src/server/agent/cpu-diagnostics.js");
	await getCpuDiagnostics().flush(reason);
	const lines = fs.readFileSync(diagFile, "utf-8").trim().split(/\r?\n/);
	return JSON.parse(lines.at(-1)!);
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

function initRepo(name: string): string {
	const repo = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	git(repo, "checkout", "-q", "-b", "master");
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

after(async () => {
	try {
		const { getCpuDiagnostics } = await import("../src/server/agent/cpu-diagnostics.js");
		await getCpuDiagnostics().shutdown();
	} catch { /* ignore */ }
	restoreEnv();
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("subsystem CPU attribution", () => {
	it("records child-process attribution for native git status", async () => {
		const repo = initRepo("git-status");
		const { runBatchGitStatusNative } = await import("../src/server/skills/git-status-native.js");

		const result = await runBatchGitStatusNative(repo);
		assert.ok(result);

		const snapshot = await flushSnapshot("git-status");
		assert.ok(snapshot.child["git status"], "git status child bucket should be present");
		assert.ok(snapshot.child["git status"].count >= 1);
		assert.ok(snapshot.child["git status"].metadata.operation["rev-parse"] >= 1);
	});

	it("records Docker child attribution and sandbox health timers", async () => {
		const { getDockerResourceLimits, _resetDockerLimitsCache, ProjectSandbox } = await import("../src/server/agent/project-sandbox.js");
		_resetDockerLimitsCache();
		await getDockerResourceLimits();

		const sandbox = new ProjectSandbox({
			projectId: "diag-project",
			projectDir: tmpRoot,
			repoUrl: "https://example.invalid/repo.git",
			image: "bobbit-test-image",
		});
		await (sandbox as any)._healthCheck();

		const snapshot = await flushSnapshot("sandbox");
		assert.ok(snapshot.child["docker info"], "docker info child bucket should be present even on failure");
		assert.equal(snapshot.timers["project-sandbox:healthCheck"].skippedStarting, 1);
	});

	it("records inbox nudger timer counters without changing nudge behavior", async () => {
		const { InboxStore } = await import("../src/server/agent/inbox-store.js");
		const { InboxNudger } = await import("../src/server/agent/inbox-nudger.js");
		const stateDir = fs.mkdtempSync(path.join(tmpRoot, "inbox-"));
		const inboxStore = new InboxStore(stateDir);
		const staff: any = { id: "staff-1", state: "active", currentSessionId: "session-1", contextPolicy: "preserve" };
		const session = { id: "session-1", status: "idle", rpcClient: {} };
		const enqueued: any[] = [];
		const nudger = new InboxNudger({
			inboxStore,
			staffManager: {
				listStaff: () => [staff],
				getStaff: (id: string) => id === staff.id ? staff : undefined,
				updateStaff: () => undefined,
			} as any,
			sessionManager: {
				getSession: (id: string) => id === session.id ? session : undefined,
				enqueuePrompt: async (sessionId: string, prompt: string, opts: any) => { enqueued.push({ sessionId, prompt, opts }); },
			} as any,
		});
		inboxStore.put({
			id: "entry-1",
			staffId: staff.id,
			source: { type: "trigger", triggerId: "trigger-1" },
			title: "Work",
			prompt: "Do work",
			state: "pending",
			createdAt: Date.now(),
		});

		(nudger as any).tick();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(enqueued.length, 1);
		assert.equal(enqueued[0].sessionId, session.id);
		const snapshot = await flushSnapshot("inbox");
		assert.equal(snapshot.timers["inbox-nudger:tick"].staffScanned, 1);
		assert.equal(snapshot.timers["inbox-nudger:tickOne"].pendingListCalls, 1);
		assert.equal(snapshot.timers["inbox-nudger:tickOne"].nudgesScheduled, 1);
		assert.equal(snapshot.timers["inbox-nudger:applyPolicyThenNudge"].nudgesSent, 1);
	});

	it("records staff trigger scan timers and git child attribution", async () => {
		const repo = initRepo("trigger");
		const { TriggerEngine } = await import("../src/server/agent/staff-trigger-engine.js");
		const trigger: any = { id: "git-1", type: "git", enabled: true, config: { repo, branch: "HEAD" } };
		const staff: any = { id: "staff-1", name: "Staff", state: "active", cwd: repo, triggers: [trigger] };
		const staffManager = {
			listStaff: () => [staff],
			updateTriggerState: (_staffId: string, triggerId: string, update: any) => {
				if (triggerId === trigger.id) Object.assign(trigger, update);
			},
		};
		const engine = new TriggerEngine(staffManager as any, { getSession: () => null } as any, { enqueue: () => undefined } as any);

		(engine as any).tick();

		const snapshot = await flushSnapshot("trigger");
		assert.equal(snapshot.timers["staff-trigger-engine:tick"].staffScanned, 1);
		assert.equal(snapshot.timers["staff-trigger-engine:tick"].gitChecks, 1);
		assert.ok(snapshot.child["staff-trigger:git"].count >= 1);
	});

	it("records worktree pool and setup timers plus git child attribution", async () => {
		const repo = initRepo("pool");
		const origin = fs.mkdtempSync(path.join(tmpRoot, "pool-origin-"));
		git(tmpRoot, "init", "--bare", "-q", origin);
		git(repo, "remote", "add", "origin", origin);
		git(repo, "push", "-u", "origin", "master");
		const { WorktreePool } = await import("../src/server/agent/worktree-pool.js");
		const { runComponentSetups } = await import("../src/server/skills/worktree-setup.js");
		const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });

		assert.equal(await pool.claim("session/test"), null);
		await (pool as any).freshen(repo, "session/test");
		await runComponentSetups({
			components: [{ name: "web", repo: ".", worktreeSetupCommand: "echo ok" } as any],
			branchContainer: repo,
			primaryWorktreeRoot: repo,
			exec: async () => undefined,
		});

		const snapshot = await flushSnapshot("worktree");
		assert.equal(snapshot.timers["worktree-pool:claim"].empty, 1);
		assert.equal(snapshot.timers["worktree-pool:freshen"].fetchResetErrors, 0);
		assert.equal(snapshot.timers["worktree-setup:run"].commands, 1);
		assert.equal(snapshot.timers["worktree-setup:component"].successes, 1);
		assert.ok(snapshot.child["git fetch"].count >= 1);
	});

	it("leaves attribution no-op when diagnostics are disabled", () => {
		const disabledFile = path.join(tmpRoot, "disabled.jsonl");
		const env = { ...process.env };
		delete env.BOBBIT_CPU_DIAG;
		env.BOBBIT_CPU_DIAG_JSONL = disabledFile;
		const worktreePoolUrl = pathToFileURL(path.resolve("src/server/agent/worktree-pool.ts")).href;
		const diagnosticsUrl = pathToFileURL(path.resolve("src/server/agent/cpu-diagnostics.ts")).href;
		const script = `
			const { WorktreePool } = await import(${JSON.stringify(worktreePoolUrl)});
			const { getCpuDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)});
			const pool = new WorktreePool({ repoPath: process.cwd(), targetSize: 0 });
			const result = await pool.claim("session/disabled");
			if (result !== null) process.exit(2);
			await getCpuDiagnostics().flush("disabled");
		`;
		const scriptPath = path.join(tmpRoot, "disabled-check.mjs");
		fs.writeFileSync(scriptPath, script);
		execSync(`npx tsx ${JSON.stringify(scriptPath)}`, {
			cwd: process.cwd(),
			env,
			stdio: "pipe",
		});
		assert.equal(fs.existsSync(disabledFile), false);
	});
});
