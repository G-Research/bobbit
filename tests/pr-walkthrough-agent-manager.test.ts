import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir = "";

const { WalkthroughAgentStore } = await import("../src/server/pr-walkthrough/walkthrough-agent-store.ts");
const { WalkthroughAgentManager } = await import("../src/server/pr-walkthrough/walkthrough-agent-manager.ts");
const { handlePrWalkthroughApiRoute } = await import("../src/server/pr-walkthrough/routes.ts");
const { getWalkthrough } = await import("../src/server/pr-walkthrough/walkthrough-store.ts");

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

function submitProof(sessionManager: ReturnType<typeof makeSessionManager>, childSessionId: string): string {
	const proof = sessionManager.sessions.get(childSessionId)?.env?.BOBBIT_WALKTHROUGH_SUBMIT_PROOF;
	assert.equal(typeof proof, "string");
	return proof;
}

function submitProofHash(jobId: string, childSessionId: string, proof: string): string {
	return createHash("sha256").update(`${jobId}\0${childSessionId}\0${proof}`).digest("hex");
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
				rolePrompt: opts?.rolePrompt,
				allowedTools: opts?.allowedTools,
				env: opts?.env,
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

function validYaml(prNumber = 42, options: { baseSha?: string; headSha?: string; reviewChunk?: string; chunkOrder?: string } = {}): string {
	return `schema_version: 1
pr:
  provider: github
  owner: acme
  repo: widgets
  number: ${prNumber}
  title: Demo PR
  url: https://github.com/acme/widgets/pull/${prNumber}
  base_sha: "${options.baseSha ?? "abcdef1"}"
  head_sha: "${options.headSha ?? "1234567"}"
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
  review_chunks:${options.reviewChunk ?? " []"}
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm behavior
  display:
    phase_order: [orientation, design, significant, other, audit]
    chunk_order:${options.chunkOrder ?? " []"}
`;
}

function createGitDiffFixture(): { baseSha: string; headSha: string; hunkHeader: string; filePath: string } {
	execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: tempDir });
	execFileSync("git", ["config", "user.name", "Tests"], { cwd: tempDir });
	execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: tempDir });
	const srcDir = path.join(tempDir, "src");
	fs.mkdirSync(srcDir, { recursive: true });
	const filePath = "src/demo.ts";
	fs.writeFileSync(path.join(tempDir, filePath), "export const value = 1;\n", "utf-8");
	execFileSync("git", ["add", filePath], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
	const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();
	fs.writeFileSync(path.join(tempDir, filePath), "export const value = 2;\nexport const label = 'demo';\n", "utf-8");
	execFileSync("git", ["add", filePath], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "change"], { cwd: tempDir, stdio: "ignore" });
	const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();
	const diff = execFileSync("git", ["diff", `${baseSha}..${headSha}`], { cwd: tempDir, encoding: "utf-8" });
	const hunkHeader = diff.split(/\r?\n/).find(line => line.startsWith("@@ "));
	assert.ok(hunkHeader);
	return { baseSha, headSha, hunkHeader, filePath };
}

function yamlReviewChunkFor(fixture: { hunkHeader: string; filePath: string }): { reviewChunk: string; chunkOrder: string } {
	return {
		reviewChunk: `
    - id: demo-change
      phase: significant
      title: Demo value change
      reviewer_goal: Confirm the demo value change is intentional.
      explanation: The exported demo value changes and a label is added.
      files:
        - ${fixture.filePath}
      relevant_hunks:
        - file: ${fixture.filePath}
          hunk_header: "${fixture.hunkHeader.replace(/"/g, "\\\"")}"
          line_range: "1-2"
          why_relevant: Shows the changed export.
      suggested_concerns: []
      positive_notes:
        - Small focused change`,
		chunkOrder: `
      - demo-change`,
	};
}

async function callRoute(manager: InstanceType<typeof WalkthroughAgentManager>, method: string, pathname: string, body?: unknown, extraDeps: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	const res = makeResponse();
	const handled = await handlePrWalkthroughApiRoute(new URL(`http://localhost${pathname}`), { method, headers } as any, res as any, {
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
		assert.deepEqual(child.allowedTools, ["readonly_bash", "submit_pr_walkthrough_yaml"]);

		const second = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(second.created, false);
		assert.equal(second.childSessionId, first.childSessionId);
	});

	it("concurrent duplicate launches share one child job", async () => {
		const sessionManager = makeSessionManager();
		const originalCreateSession = sessionManager.createSession.bind(sessionManager);
		let createCount = 0;
		let releaseCreate: (() => void) | undefined;
		const createBarrier = new Promise<void>(resolve => { releaseCreate = resolve; });
		sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
			createCount += 1;
			await createBarrier;
			return originalCreateSession(...args);
		};
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launches = Array.from({ length: 8 }, () => manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" }));
		await new Promise(resolve => setTimeout(resolve, 0));
		releaseCreate?.();
		const results = await Promise.all(launches);

		assert.equal(createCount, 1);
		assert.equal(new Set(results.map(result => result.childSessionId)).size, 1);
		assert.equal(results.filter(result => result.created).length, 1);
		assert.equal(new WalkthroughAgentStore(tempDir).list().filter(job => job.target.canonicalKey === "github:acme/widgets#42").length, 1);
	});

	it("launch rejects unknown and stale parent sessions", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		await assert.rejects(
			() => manager.launch({ sessionId: "missing-parent", prUrl: "https://github.com/acme/widgets/pull/42" }),
			/Parent session missing-parent was not found/,
		);
		sessionManager.sessions.set("stale-parent", { id: "stale-parent", cwd: tempDir, status: "terminated" });
		await assert.rejects(
			() => manager.launch({ sessionId: "stale-parent", prUrl: "https://github.com/acme/widgets/pull/42" }),
			/no longer active/,
		);
		assert.equal(new WalkthroughAgentStore(tempDir).list().length, 0);
	});

	it("launch prompts include the required YAML schema fields and enums", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		const child = sessionManager.sessions.get(launch.childSessionId);
		const promptText = `${child.rolePrompt}\n${sessionManager.prompts.join("\n")}`;
		assert.match(promptText, /schema_version: 1/);
		assert.match(promptText, /original_description:/);
		assert.match(promptText, /recommendation: approve\|comment\|request_changes\|unknown/);
		assert.match(promptText, /phase: significant\|other\|audit/);
		assert.match(promptText, /category: tests\|docs\|migration\|telemetry\|security\|performance\|compatibility\|cleanup\|other/);
		assert.match(promptText, /phase_order:/);
	});

	it("launch preflight surfaces GitHub auth and availability errors as job errors", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			preflightGithubLaunch: () => { throw new Error("GitHub API rate limit exceeded"); },
		});

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(launch.status, "error");
		assert.equal(launch.job.error?.code, "GITHUB_RATE_LIMITED");
		assert.equal(launch.job.error?.retryable, true);
		assert.equal(sessionManager.prompts.length, 1, "child transcript should receive a launch failure notice");
		assert.match(sessionManager.prompts[0], /launch preflight failed|GITHUB_RATE_LIMITED|rate limit/i);
		assert.doesNotMatch(sessionManager.prompts[0], /schema_version: 1/, "kickoff schema prompt should not be sent for inaccessible PRs");
	});

	it("launch kickoff failures are surfaced in the child transcript", async () => {
		const sessionManager = makeSessionManager();
		sessionManager.enqueuePrompt = () => ({ success: false, error: "dispatch exploded" });
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(launch.status, "error");
		assert.equal(launch.job.error?.code, "PROMPT_DISPATCH_FAILED");
		assert.match(sessionManager.prompts.at(-1) ?? "", /kickoff prompt dispatch failed|PROMPT_DISPATCH_FAILED|dispatch exploded/i);
	});

	it("runtime failures before YAML transition the job to AGENT_RUNTIME_FAILED", async () => {
		const sessionManager = makeSessionManager();
		const events: Record<string, unknown>[] = [];
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			broadcast: event => events.push(event),
		});
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		const promptCountAfterLaunch = sessionManager.prompts.length;

		sessionManager.sessions.get(launch.childSessionId).emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model stream crashed" } });
		await new Promise(resolve => setTimeout(resolve, 0));

		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "error");
		assert.equal(job?.error?.code, "AGENT_RUNTIME_FAILED");
		assert.match(job?.error?.message ?? "", /model stream crashed/);
		assert.ok(sessionManager.sessions.has(launch.childSessionId), "child session is preserved for diagnostics");
		assert.ok(events.some(event => (event as any).job?.error?.code === "AGENT_RUNTIME_FAILED"));

		sessionManager.sessions.get(launch.childSessionId).emit({ type: "agent_end" });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(sessionManager.prompts.length, promptCountAfterLaunch + 1, "runtime error notice is sent but idle reminder is not");
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

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: "schema_version: 1\n", submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, false);
		assert.equal(result.status, "validation_failed");
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "validation_failed");
		assert.equal(job?.lastValidationError?.code, "YAML_SCHEMA_INVALID");
		assert.equal(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")), false);
	});

	it("rejects second successful YAML submissions without mutating the published payload", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const first = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(first.ok, true);
		const publishedAt = manager.getJob(launch.jobId)?.payloadUpdatedAt;
		await assert.rejects(
			() => manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: submitProof(sessionManager, launch.childSessionId) }),
			/already accepted a YAML submission/,
		);
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "ready");
		assert.equal(job?.payloadUpdatedAt, publishedAt);
	});

	it("submit-yaml rejects SHA mismatches against authoritative resolved PR metadata", async () => {
		const authoritativeBase = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const authoritativeHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			resolveDiffForYamlMapping: () => ({
				changeset: { baseSha: authoritativeBase, headSha: authoritativeHead, provider: "github" },
				files: [],
			}),
		});
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const mismatch = await manager.submitYaml({
			sessionId: launch.childSessionId,
			jobId: launch.jobId,
			yaml: validYaml(42, { baseSha: "ccccccc", headSha: authoritativeHead.slice(0, 7) }),
			submissionProof: submitProof(sessionManager, launch.childSessionId),
		});
		assert.equal(mismatch.ok, false);
		assert.equal(mismatch.status, "validation_failed");
		assert.match(mismatch.validation.errors.map(error => `${error.path}: ${error.message}`).join("\n"), /\$\.pr\.base_sha: Must match the authoritative PR base SHA/);
		assert.equal(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")), false);

		const accepted = await manager.submitYaml({
			sessionId: launch.childSessionId,
			jobId: launch.jobId,
			yaml: validYaml(42, { baseSha: authoritativeBase.slice(0, 7), headSha: authoritativeHead.slice(0, 7) }),
			submissionProof: submitProof(sessionManager, launch.childSessionId),
		});
		assert.equal(accepted.ok, true);
		const stored = getWalkthrough(launch.changesetId, tempDir);
		assert.equal(stored?.changeset.baseSha, authoritativeBase);
		assert.equal(stored?.changeset.headSha, authoritativeHead);
	});

	it("internal submit accepts valid YAML with the real schema mapper and keeps the child session alive", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, true);
		assert.equal(result.status, "ready");
		assert.equal(sessionManager.sessions.get(launch.childSessionId).status, "idle");
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "ready");
		assert.ok(job?.submittedAt);
		assert.ok(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")));
		assert.deepEqual(result.warnings.filter(warning => warning.code === "yaml-fallback-mapper"), []);
	});

	it("valid YAML submission maps relevant hunks to resolved diff blocks", async () => {
		const fixture = createGitDiffFixture();
		const chunk = yamlReviewChunkFor(fixture);
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const result = await manager.submitYaml({
			sessionId: launch.childSessionId,
			jobId: launch.jobId,
			yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha, ...chunk }),
			submissionProof: submitProof(sessionManager, launch.childSessionId),
		});

		assert.equal(result.ok, true);
		const stored = getWalkthrough(launch.changesetId, tempDir);
		assert.ok(stored);
		const reviewCard = stored.cards.find((card: any) => card.id === "significant-demo-change");
		assert.ok(reviewCard, "expected review chunk card to be stored");
		assert.ok(reviewCard.diffBlocks.length > 0, "expected relevant_hunks to map to non-empty diffBlocks");
		assert.equal(reviewCard.diffBlocks[0].filePath, fixture.filePath);
		assert.equal(stored.warnings.some((warning: any) => warning.code === "unmapped_hunk"), false);
	});

	it("submit-yaml converts diff resolution failures into structured job errors", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			resolveDiffForYamlMapping: () => { throw new Error("GitHub API rate limit exceeded"); },
		});
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		await assert.rejects(
			() => manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(), submissionProof: submitProof(sessionManager, launch.childSessionId) }),
			/GitHub API rate limit exceeded/,
		);
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "error");
		assert.equal(job?.error?.code, "GITHUB_RATE_LIMITED");
		assert.equal(job?.error?.retryable, true);
	});

	it("internal submit validates YAML identity against the launch target", async () => {
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(43), submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, false);
		assert.equal(result.status, "validation_failed");
		assert.match(result.validation.errors.map(error => `${error.path}: ${error.message}`).join("\n"), /pr number 42|URL https:\/\/github\.com\/acme\/widgets\/pull\/42/);
	});

	it("route preserves structured error extras from manager failures", async () => {
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			store: new WalkthroughAgentStore(tempDir),
			validateYaml: () => { throw Object.assign(new Error("already ready"), { status: 409, extra: { code: "WALKTHROUGH_ALREADY_READY", retryable: false, job: { jobId: "job-1" } } }); },
		});
		const store = (manager as any).store as WalkthroughAgentStore;
		const proof = "scoped-proof";
		store.create({
			jobId: "job-1",
			parentSessionId: "parent",
			childSessionId: "child",
			cwd: tempDir,
			target: { provider: "github", canonicalKey: "github:acme/widgets#42", owner: "acme", repo: "widgets", number: 42 },
			changesetId: "github:acme/widgets#42",
			tabId: "walkthrough:github:acme/widgets#42",
			status: "waiting_for_yaml",
			title: "PR #42 Walkthrough",
			submissionProofHash: submitProofHash("job-1", "child", proof),
		});

		const result = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: "child", jobId: "job-1", yaml: validYaml() }, {}, { "x-bobbit-walkthrough-submit-proof": proof });
		assert.equal(result.status, 409);
		assert.equal(result.body.code, "WALKTHROUGH_ALREADY_READY");
		assert.equal(result.body.retryable, false);
		assert.equal(result.body.job.jobId, "job-1");
	});

	it("route constructs a stable manager across fresh dependency objects", async () => {
		const sessionManager = makeSessionManager();
		const body = { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" };
		const first = await callRoute(undefined as any, "POST", "/api/pr-walkthrough/launch", body, { sessionManager, broadcast: () => undefined });
		const second = await callRoute(undefined as any, "POST", "/api/pr-walkthrough/launch", body, { sessionManager, broadcast: () => undefined });
		assert.equal(first.status, 201);
		assert.equal(second.status, 200);
		assert.equal(second.body.childSessionId, first.body.childSessionId);
	});

	it("restore reattaches idle-reminder listeners for non-ready jobs", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		const restoredManager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		restoredManager.restore();
		sessionManager.sessions.get(launch.childSessionId).emit({ type: "agent_end" });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.match(sessionManager.prompts.at(-1) ?? "", /went idle without publishing|submit_pr_walkthrough_yaml/);
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
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await callRoute(manager, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(launch.status, 201);
		assert.equal(launch.body.status, "waiting_for_yaml");
		assert.equal(launch.body.job.submissionProofHash, undefined);

		const job = await callRoute(manager, "GET", `/api/pr-walkthrough/jobs/${encodeURIComponent(launch.body.jobId)}`);
		assert.equal(job.status, 200);
		assert.equal(job.body.job.childSessionId, launch.body.childSessionId);
		assert.equal(job.body.job.submissionProofHash, undefined);

		const session = await callRoute(manager, "GET", `/api/pr-walkthrough/session/${encodeURIComponent(launch.body.childSessionId)}`);
		assert.equal(session.status, 200);
		assert.equal(session.body.job.jobId, launch.body.jobId);
		const proof = submitProof(sessionManager, launch.body.childSessionId);

		const missingProof = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: "schema_version: 1\n" });
		assert.equal(missingProof.status, 403);
		assert.equal(missingProof.body.code, "WALKTHROUGH_SUBMIT_PROOF_REQUIRED");
		assert.equal(manager.getJob(launch.body.jobId)?.status, "waiting_for_yaml");

		const invalid = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: "schema_version: 1\n" }, {}, { "x-bobbit-walkthrough-submit-proof": proof });
		assert.equal(invalid.status, 200);
		assert.equal(invalid.body.ok, false);

		const valid = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }) }, {}, { "x-bobbit-walkthrough-submit-proof": proof });
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
			() => manager.submitYaml({ sessionId: "other-session", jobId: launch.jobId, yaml: validYaml(), submissionProof: submitProof(sessionManager, launch.childSessionId) }),
			/error|not allowed/i,
		);
	});
});
