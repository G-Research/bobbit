import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir = "";

const { WalkthroughAgentStore } = await import("../src/server/pr-walkthrough/walkthrough-agent-store.ts");
const { WalkthroughAgentManager } = await import("../src/server/pr-walkthrough/walkthrough-agent-manager.ts");
const { handlePrWalkthroughApiRoute } = await import("../src/server/pr-walkthrough/routes.ts");

type MockResponse = {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	writeHead: (status: number, headers: Record<string, string>) => void;
	end: (body: string) => void;
};

function makeResponse(): MockResponse {
	return {
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body) {
			this.body = body;
		},
	};
}

function makeSessionManager() {
	const sessions = new Map<string, any>();
	const prompts: string[] = [];
	sessions.set("parent", { id: "parent", cwd: tempDir, status: "idle", projectId: "project-1", sandboxed: false });
	return {
		sessions,
		prompts,
		async createSession(cwd: string, _agentArgs?: string[], _goalId?: string, _assistantType?: string, opts?: Record<string, unknown>) {
			const id = String(opts?.sessionId ?? "child");
			const listeners: Array<(event: unknown) => void> = [];
			const session = {
				id,
				cwd,
				status: "idle",
				projectId: opts?.projectId,
				sandboxed: opts?.sandboxed,
				allowedTools: opts?.allowedTools,
				rpcClient: {
					prompt: async (text: string) => { prompts.push(text); return { success: true }; },
					onEvent: (handler: (event: unknown) => void) => { listeners.push(handler); return () => undefined; },
				},
				emit: (event: unknown) => listeners.forEach(listener => listener(event)),
			};
			sessions.set(id, session);
			return session;
		},
		getSession(id: string) { return sessions.get(id); },
		getPersistedSession(id: string) { return sessions.get(id); },
		updateSessionMeta(id: string, updates: Record<string, unknown>) {
			Object.assign(sessions.get(id), updates);
			return true;
		},
		setTitle(id: string, title: string) {
			Object.assign(sessions.get(id), { title });
		},
		enqueuePrompt(_id: string, text: string) {
			prompts.push(text);
			return { status: "queued" };
		},
	};
}

function validYaml(prNumber = 42): string {
	return `schema_version: 1
pr:
  provider: github
  owner: acme
  repo: widgets
  number: ${prNumber}
  title: Demo PR
  url: https://github.com/acme/widgets/pull/${prNumber}
  base_sha: "abcdef1"
  head_sha: "1234567"
  original_description:
    body: "Demo body"
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 1
    additions: 2
    deletions: 0
walkthrough:
  context:
    why_created: Demo
    problem_solved: Solves demo
    why_worth_merging: Useful
    merge_concerns: None
    author_intent: Add demo
    reviewer_map: Read orientation first
  merge_assessment:
    recommendation: comment
    confidence: medium
    summary: Looks reasonable
    blocking_concerns: []
    non_blocking_concerns: []
  design_decisions: []
  review_chunks: []
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm behavior
  display:
    phase_order: [orientation, design, significant, other, audit]
    chunk_order: []
`;
}

async function callRoute(manager: InstanceType<typeof WalkthroughAgentManager>, method: string, pathname: string, body?: unknown, extraDeps: Record<string, unknown> = {}) {
	const res = makeResponse();
	const handled = await handlePrWalkthroughApiRoute(new URL(`http://localhost${pathname}`), { method } as any, res as any, {
		defaultCwd: tempDir,
		readBody: async () => body,
		walkthroughAgentManager: manager,
		...extraDeps,
	});
	assert.equal(handled, true);
	return { status: res.status, body: JSON.parse(res.body ?? "{}") };
}

describe("WalkthroughAgentManager", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prw-agent-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("launch creates a waiting child job and dedupes by parent plus target", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const first = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(first.created, true);
		assert.equal(first.status, "waiting_for_yaml");
		assert.equal(first.job.parentSessionId, "parent");
		assert.equal(first.job.target.canonicalKey, "github:acme/widgets#42");
		const child = sessionManager.sessions.get(first.childSessionId);
		assert.equal(child.parentSessionId, "parent");
		assert.equal(child.childKind, "pr-walkthrough");
		assert.equal(child.readOnly, true);
		assert.deepEqual(child.allowedTools, ["read", "grep", "find", "ls", "readonly_bash", "submit_pr_walkthrough_yaml"]);

		const second = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(second.created, false);
		assert.equal(second.childSessionId, first.childSessionId);
	});

	it("retry after pre-child createSession failure creates a fresh child job", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const originalCreateSession = sessionManager.createSession.bind(sessionManager);
		let failOnce = true;
		sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("create failed before child persisted");
			}
			return originalCreateSession(...args);
		};
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });

		await assert.rejects(
			() => manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" }),
			/create failed before child persisted/,
		);
		const failedJob = store.findByParentAndTarget("parent", "github:acme/widgets#42");
		assert.equal(failedJob?.status, "error");
		assert.equal(sessionManager.sessions.has(failedJob!.childSessionId), false);

		const retry = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(retry.created, true);
		assert.equal(retry.status, "waiting_for_yaml");
		assert.notEqual(retry.childSessionId, failedJob?.childSessionId);
		assert.ok(sessionManager.sessions.has(retry.childSessionId));
	});

	it("internal submit stores validation failures without publishing cards", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: "schema_version: 1\n" });
		assert.equal(result.ok, false);
		assert.equal(result.status, "validation_failed");
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "validation_failed");
		assert.equal(job?.lastValidationError?.code, "YAML_SCHEMA_INVALID");
		assert.equal(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")), false);
	});

	it("internal submit accepts valid YAML with the real schema mapper and keeps the child session alive", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml() });
		assert.equal(result.ok, true);
		assert.equal(result.status, "ready");
		assert.equal(sessionManager.sessions.get(launch.childSessionId).status, "idle");
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "ready");
		assert.ok(job?.submittedAt);
		assert.ok(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")));
		assert.deepEqual(result.warnings.filter(warning => warning.code === "yaml-fallback-mapper"), []);
	});

	it("internal submit validates YAML identity against the launch target", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(43) });
		assert.equal(result.ok, false);
		assert.equal(result.status, "validation_failed");
		assert.match(result.validation.errors.map(error => `${error.path}: ${error.message}`).join("\n"), /pr number 42|URL https:\/\/github\.com\/acme\/widgets\/pull\/42/);
	});

	it("route constructs the production manager with SessionManager and broadcast dependencies", async () => {
		const sessionManager = makeSessionManager();
		const events: Record<string, unknown>[] = [];
		const res = makeResponse();
		const handled = await handlePrWalkthroughApiRoute(new URL("http://localhost/api/pr-walkthrough/launch"), { method: "POST" } as any, res as any, {
			defaultCwd: tempDir,
			stateDir: tempDir,
			readBody: async () => ({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" }),
			sessionManager,
			broadcast: event => events.push(event),
		});
		assert.equal(handled, true);
		assert.equal(res.status, 201);
		const body = JSON.parse(res.body ?? "{}");
		assert.equal(body.status, "waiting_for_yaml");
		assert.ok(sessionManager.sessions.get(body.childSessionId));
		assert.ok(events.some(event => event.type === "pr_walkthrough_job_updated"));
	});

	it("route exposes launch, job restore, session restore, and submit-yaml", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await callRoute(manager, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(launch.status, 201);
		assert.equal(launch.body.status, "waiting_for_yaml");

		const job = await callRoute(manager, "GET", `/api/pr-walkthrough/jobs/${encodeURIComponent(launch.body.jobId)}`);
		assert.equal(job.status, 200);
		assert.equal(job.body.job.childSessionId, launch.body.childSessionId);

		const session = await callRoute(manager, "GET", `/api/pr-walkthrough/session/${encodeURIComponent(launch.body.childSessionId)}`);
		assert.equal(session.status, 200);
		assert.equal(session.body.job.jobId, launch.body.jobId);

		const invalid = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: "schema_version: 1\n" });
		assert.equal(invalid.status, 200);
		assert.equal(invalid.body.ok, false);

		const valid = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: validYaml() });
		assert.equal(valid.status, 200);
		assert.equal(valid.body.ok, true);
	});

	it("sandbox submit-yaml rejects child sessions outside the caller scope", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await callRoute(manager, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const result = await callRoute(
			manager,
			"POST",
			"/api/internal/pr-walkthrough/submit-yaml",
			{ sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: validYaml() },
			{ sandboxScope: { projectId: "project-1", sessionIds: new Set(["other-session"]), goalIds: new Set() } },
		);

		assert.equal(result.status, 403);
		assert.equal(result.body.code, "SANDBOX_SESSION_OUT_OF_SCOPE");
		assert.equal(manager.getJob(launch.body.jobId)?.status, "waiting_for_yaml");
	});

	it("submit-yaml rejects a different child session for the same job", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		await assert.rejects(
			() => manager.submitYaml({ sessionId: "other-session", jobId: launch.jobId, yaml: validYaml() }),
			/error|not allowed/i,
		);
	});
});
