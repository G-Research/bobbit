import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir = "";

const { WalkthroughAgentStore, rotateSubmissionProofForRestoredJob, verifySubmissionProof } = await import("../src/server/pr-walkthrough/walkthrough-agent-store.ts");
const { WalkthroughAgentManager } = await import("../src/server/pr-walkthrough/walkthrough-agent-manager.ts");
const { createAnalysisBundleFromParsedDiff } = await import("../src/server/pr-walkthrough/walkthrough-analysis-bundle.ts");
const { evaluateWalkthroughReadonlyCommand } = await import("../src/server/pr-walkthrough/walkthrough-readonly-policy.ts");
const { handlePrWalkthroughApiRoute } = await import("../src/server/pr-walkthrough/routes.ts");
const { getWalkthrough } = await import("../src/server/pr-walkthrough/walkthrough-store.ts");
const { shouldReapWalkthroughChildOnBoot } = await import("../src/server/pr-walkthrough/walkthrough-reap.ts");
const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");

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
	const terminated: string[] = [];
	sessions.set("parent", { id: "parent", cwd: tempDir, status: "idle", projectId: "project-1", sandboxed: false });
	return {
		sessions,
		prompts,
		terminated,
		async terminateSession(id: string) {
			this.terminated.push(id);
			this.sessions.delete(id);
			return true;
		},
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

function addGithubOrigin(owner = "acme", repo = "widgets"): void {
	try {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
	} catch { /* repo may already exist */ }
	try {
		execFileSync("git", ["remote", "remove", "origin"], { cwd: tempDir, stdio: "ignore" });
	} catch { /* origin may not exist */ }
	execFileSync("git", ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], { cwd: tempDir });
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

function jsonFilesUnder(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...jsonFilesUnder(fullPath));
		else if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
	}
	return files;
}

function readAnalysisBundleArtifacts(): Array<Record<string, any>> {
	return jsonFilesUnder(tempDir)
		.map(file => {
			try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
		})
		.filter((value): value is Record<string, any> => value?.kind === "pr_walkthrough_analysis_bundle");
}

function removeAnalysisBundleArtifacts(): void {
	for (const file of jsonFilesUnder(tempDir)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (parsed?.kind === "pr_walkthrough_analysis_bundle") fs.rmSync(file, { force: true });
		} catch { /* ignore non-bundle JSON */ }
	}
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
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const first = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(first.created, true);
		assert.equal(first.status, "waiting_for_yaml");
		assert.equal(first.job.parentSessionId, "parent");
		assert.equal(first.job.target.canonicalKey, "github:acme/widgets#42");
		const child = sessionManager.sessions.get(first.childSessionId);
		assert.equal(child.parentSessionId, "parent");
		assert.equal(child.childKind, "pr-walkthrough");
		assert.equal(child.readOnly, true);
		assert.deepEqual(child.allowedTools, ["readonly_bash", "read_pr_walkthrough_bundle", "submit_pr_walkthrough_yaml"]);

		const second = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(second.created, false);
		assert.equal(second.childSessionId, first.childSessionId);
	});

	it("number-only GitHub launches infer owner/repo before child env and persistence", async () => {
		const fixture = createGitDiffFixture();
		addGithubOrigin("acme", "widgets");
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prNumber: 42, baseSha: fixture.baseSha, headSha: fixture.headSha });

		assert.equal(launch.job.target.canonicalKey, "github:acme/widgets#42");
		assert.equal(launch.job.target.owner, "acme");
		assert.equal(launch.job.target.repo, "widgets");
		assert.equal(launch.job.target.prUrl, "https://github.com/acme/widgets/pull/42");
		assert.doesNotMatch(launch.job.target.canonicalKey, /unknown\/unknown/);
		const child = sessionManager.sessions.get(launch.childSessionId);
		assert.equal(child.env.BOBBIT_WALKTHROUGH_TARGET_PROVIDER, "github");
		assert.equal(child.env.BOBBIT_WALKTHROUGH_TARGET_OWNER, "acme");
		assert.equal(child.env.BOBBIT_WALKTHROUGH_TARGET_REPO, "widgets");
		assert.equal(child.env.BOBBIT_WALKTHROUGH_TARGET_NUMBER, "42");
	});

	it("launch resolves and persists a full versioned analysis bundle before child creation", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const originalCreateSession = sessionManager.createSession.bind(sessionManager);
		let bundleCountAtCreate = -1;
		let bundleCountAtEnqueue = -1;
		sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
			bundleCountAtCreate = readAnalysisBundleArtifacts().length;
			return originalCreateSession(...args);
		};
		const originalEnqueuePrompt = sessionManager.enqueuePrompt.bind(sessionManager);
		sessionManager.enqueuePrompt = (...args: Parameters<typeof sessionManager.enqueuePrompt>) => {
			bundleCountAtEnqueue = readAnalysisBundleArtifacts().length;
			return originalEnqueuePrompt(...args);
		};
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		assert.equal(launch.status, "waiting_for_yaml");
		assert.ok(bundleCountAtCreate > 0, "analysis bundle must be persisted before child session creation");
		assert.ok(bundleCountAtEnqueue > 0, "analysis bundle must be persisted before kickoff prompt enqueue");
		const [bundle] = readAnalysisBundleArtifacts();
		assert.ok(bundle, "expected a persisted pr_walkthrough_analysis_bundle artifact");
		assert.equal(bundle.schema_version, 1);
		assert.equal(bundle.kind, "pr_walkthrough_analysis_bundle");
		assert.deepEqual(bundle.target, {
			provider: "github",
			owner: "acme",
			repo: "widgets",
			number: 42,
			url: "https://github.com/acme/widgets/pull/42",
		});
		assert.equal(bundle.changeset.base_sha, fixture.baseSha);
		assert.equal(bundle.changeset.head_sha, fixture.headSha);
		assert.equal(bundle.changeset.files_changed, 1);
		assert.ok(Array.isArray(bundle.files), "bundle.files must contain the authoritative launch-time diff files");
		assert.ok(bundle.files.some((file: any) => file.path === fixture.filePath && Array.isArray(file.hunks) && file.hunks.length > 0), "bundle must include parsed hunks for the changed file");
		const child = sessionManager.sessions.get(launch.childSessionId);
		assert.ok(child.allowedTools.includes("read_pr_walkthrough_bundle"), "walkthrough child must be allowed to read its scoped persisted bundle");
		assert.match(`${child.rolePrompt}\n${sessionManager.prompts.join("\n")}`, /read_pr_walkthrough_bundle/);
	});

	it("analysis bundle preserves parsed files without diff blocks and avoids metadata index drift", () => {
		const bundle = createAnalysisBundleFromParsedDiff({
			jobId: "job-bundle-files",
			parentSessionId: "parent",
			childSessionId: "child",
			cwd: tempDir,
			target: { provider: "github", canonicalKey: "github:acme/widgets#42", owner: "acme", repo: "widgets", number: 42, prUrl: "https://github.com/acme/widgets/pull/42" },
			changesetId: "github:acme/widgets#42",
			tabId: "walkthrough:github:acme/widgets#42",
			status: "waiting_for_yaml",
			title: "PR #42 Walkthrough",
		}, {
			changeset: { baseSha: "base", headSha: "head", provider: "github", filesChanged: 2, additions: 8, deletions: 2 },
			files: [
				{ filePath: "assets/logo.png", status: "modified", additions: 0, deletions: 0, isBinary: true, isGenerated: false, isTruncated: true, blobUrl: "https://example.test/blob", rawUrl: "https://example.test/raw", contentsUrl: "https://example.test/contents", diffBlocks: [] },
				{ filePath: "src/demo.ts", status: "modified", additions: 8, deletions: 2, isBinary: false, isGenerated: true, isTruncated: false, externalUrl: "https://example.test/diff", diffBlocks: [{ id: "block-demo", filePath: "src/demo.ts", status: "modified", isGenerated: true, hunks: [{ id: "hunk-demo", header: "@@ -1,1 +1,2 @@", lines: [{ id: "line-demo", kind: "add", side: "new", newLine: 2, text: "export const value = 2;" }] }] }] },
			],
		});

		assert.equal(bundle.files.length, 2);
		assert.deepEqual(bundle.files.map(file => file.path), ["assets/logo.png", "src/demo.ts"]);
		assert.equal(bundle.files[0].hunks.length, 0, "files without diff blocks must remain in the launch bundle");
		assert.equal(bundle.files[0].is_binary, true);
		assert.equal(bundle.files[0].is_truncated, true);
		assert.equal(bundle.files[0].blob_url, "https://example.test/blob");
		assert.equal(bundle.files[1].additions, 8, "metadata must come from its own parsed file, not flattened diff-block index");
		assert.equal(bundle.files[1].deletions, 2);
		assert.equal(bundle.files[1].is_generated, true);
		assert.equal(bundle.files[1].hunks.length, 1);
	});

	it("launch-time diff resolution failure returns a structured job error without creating a waiting child agent", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store,
			preflightGithubLaunch: () => { throw new Error("GitHub API rate limit exceeded"); },
		});

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });

		assert.equal(launch.status, "error");
		assert.equal(launch.job.error?.code, "GITHUB_RATE_LIMITED");
		assert.equal(launch.job.error?.retryable, true);
		assert.equal(store.list().length, 1);
		assert.equal(store.list()[0].status, "error");
		assert.equal(sessionManager.sessions.size, 1, "expected no child session when launch-time bundle resolution fails");
		assert.equal(sessionManager.prompts.length, 0, "expected no waiting/kickoff prompt when launch-time bundle resolution fails");
	});

	it("local changeset launches are rejected before creating an agent job", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });

		await assert.rejects(
			() => manager.launch({ sessionId: "parent", baseSha: "abcdef1", headSha: "1234567" }),
			(error: any) => error?.extra?.code === "LOCAL_WALKTHROUGH_AGENT_UNSUPPORTED",
		);
		assert.equal(store.list().length, 0);
	});

	it("launch spawn-pins the walkthrough child to the parent session model", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const seenOpts: Record<string, unknown>[] = [];
		const originalCreateSession = sessionManager.createSession.bind(sessionManager);
		sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
			seenOpts.push(args[4] ?? {});
			return originalCreateSession(...args);
		};
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			resolveSessionModel: sessionId => sessionId === "parent" ? { provider: "anthropic", modelId: "claude-opus-4-1" } : undefined,
		});

		await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		assert.equal(seenOpts[0].initialModel, "anthropic/claude-opus-4-1");
	});

	it("restored non-ready jobs rotate a scoped submit proof for tool env registration", async () => {
		const store = new WalkthroughAgentStore(tempDir);
		store.create({
			jobId: "job-restore",
			parentSessionId: "parent",
			childSessionId: "child-restore",
			cwd: tempDir,
			target: { provider: "github", canonicalKey: "github:acme/widgets#42", owner: "acme", repo: "widgets", number: 42 },
			changesetId: "github:acme/widgets#42",
			tabId: "walkthrough:github:acme/widgets#42",
			status: "waiting_for_yaml",
			title: "PR #42 Walkthrough",
		});

		const env = rotateSubmissionProofForRestoredJob(tempDir, "child-restore", "job-restore");

		assert.equal(env?.BOBBIT_SESSION_ID, "child-restore");
		assert.equal(env?.BOBBIT_WALKTHROUGH_JOB_ID, "job-restore");
		assert.equal(typeof env?.BOBBIT_WALKTHROUGH_SUBMIT_PROOF, "string");
		assert.equal(env?.BOBBIT_WALKTHROUGH_TARGET_PROVIDER, "github");
		assert.equal(env?.BOBBIT_WALKTHROUGH_TARGET_OWNER, "acme");
		assert.equal(env?.BOBBIT_WALKTHROUGH_TARGET_REPO, "widgets");
		assert.equal(env?.BOBBIT_WALKTHROUGH_TARGET_NUMBER, "42");
		const restored = store.get("job-restore");
		assert.equal(verifySubmissionProof(env?.BOBBIT_WALKTHROUGH_SUBMIT_PROOF, restored!), true);
		assert.equal((restored as any).submissionProof, undefined);
		const target = {
			provider: env!.BOBBIT_WALKTHROUGH_TARGET_PROVIDER as "github",
			owner: env!.BOBBIT_WALKTHROUGH_TARGET_OWNER,
			repo: env!.BOBBIT_WALKTHROUGH_TARGET_REPO,
			number: Number(env!.BOBBIT_WALKTHROUGH_TARGET_NUMBER),
		};
		assert.equal(evaluateWalkthroughReadonlyCommand("gh pr view 42", { githubTarget: target }).allowed, true);
		const crossPr = evaluateWalkthroughReadonlyCommand("gh pr view 43", { githubTarget: target });
		assert.equal(crossPr.allowed, false);
		assert.match(crossPr.reason, /may only read launched PR #42/);

		const sessionManager = makeSessionManager();
		sessionManager.sessions.set("child-restore", { id: "child-restore", cwd: tempDir, status: "idle", env });
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		const duplicate = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42" });
		assert.equal(duplicate.created, false);
		assert.equal(duplicate.childSessionId, "child-restore");
		const retry = await manager.submitYaml({ sessionId: "child-restore", jobId: "job-restore", yaml: "schema_version: 1\n", submissionProof: env?.BOBBIT_WALKTHROUGH_SUBMIT_PROOF });
		assert.equal(retry.ok, false);
		assert.equal(retry.status, "validation_failed");
	});

	it("concurrent duplicate launches share one child job", async () => {
		const fixture = createGitDiffFixture();
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

		const launches = Array.from({ length: 8 }, () => manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha }));
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
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		const child = sessionManager.sessions.get(launch.childSessionId);
		const promptText = `${child.rolePrompt}\n${sessionManager.prompts.join("\n")}`;
		assert.match(promptText, /schema_version: 1/);
		assert.match(promptText, /original_description:/);
		assert.match(promptText, /recommendation: approve\|comment\|request_changes\|unknown/);
		assert.match(promptText, /phase: significant\|other\|audit/);
		assert.match(promptText, /category: tests\|docs\|migration\|telemetry\|security\|performance\|compatibility\|cleanup\|other/);
		assert.match(promptText, /phase_order:/);
	});

	it("launch with local SHAs skips GitHub preflight and waits for YAML", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			preflightGithubLaunch: () => { throw new Error("should not hit network when local SHAs are supplied"); },
		});

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(launch.status, "waiting_for_yaml");
		assert.equal(launch.job.target.canonicalKey, "github:acme/widgets#42");
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
		assert.equal(sessionManager.sessions.size, 1, "launch-time bundle failures should not create a child analysis session");
		assert.equal(sessionManager.prompts.length, 0, "kickoff schema prompt should not be sent for inaccessible PRs");
	});

	it("launch kickoff failures are surfaced in the child transcript", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		sessionManager.enqueuePrompt = () => ({ success: false, error: "dispatch exploded" });
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });

		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(launch.status, "error");
		assert.equal(launch.job.error?.code, "PROMPT_DISPATCH_FAILED");
		assert.match(sessionManager.prompts.at(-1) ?? "", /kickoff prompt dispatch failed|PROMPT_DISPATCH_FAILED|dispatch exploded/i);
	});

	it("runtime failures before YAML transition the job to AGENT_RUNTIME_FAILED", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const events: Record<string, unknown>[] = [];
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store: new WalkthroughAgentStore(tempDir),
			broadcast: event => events.push(event),
		});
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		const promptCountAfterLaunch = sessionManager.prompts.length;

		sessionManager.sessions.get(launch.childSessionId).emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model stream crashed" } });
		await new Promise(resolve => setTimeout(resolve, 0));

		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "error");
		assert.equal(job?.error?.code, "AGENT_RUNTIME_FAILED");
		assert.match(job?.error?.message ?? "", /model stream crashed/);
		assert.equal(sessionManager.prompts.length, promptCountAfterLaunch + 1, "runtime error notice is enqueued before the child is torn down");
		// Terminal error: the child process is torn down (after the error notice is
		// enqueued) so the failed walkthrough does not leak or respawn on restart.
		assert.ok(sessionManager.terminated.includes(launch.childSessionId), "terminal runtime failure terminates the child session");
		assert.equal(sessionManager.sessions.has(launch.childSessionId), false, "terminated child is removed from the live session map");
		assert.ok(events.some(event => (event as any).job?.error?.code === "AGENT_RUNTIME_FAILED"));
	});

	it("retry after pre-child createSession failure creates a fresh child job", async () => {
		const fixture = createGitDiffFixture();
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
			() => manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha }),
			/create failed before child persisted/,
		);
		const failedJob = store.findByParentAndTarget("parent", "github:acme/widgets#42");
		assert.equal(failedJob?.status, "error");
		assert.equal(sessionManager.sessions.has(failedJob!.childSessionId), false);

		const retry = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		assert.equal(retry.created, true);
		assert.equal(retry.status, "waiting_for_yaml");
		assert.notEqual(retry.childSessionId, failedJob?.childSessionId);
		assert.ok(sessionManager.sessions.has(retry.childSessionId));
	});

	it("internal submit stores validation failures without publishing cards", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

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

		// Capture the proof before the first (successful) submit terminates the child.
		const proof = submitProof(sessionManager, launch.childSessionId);
		const first = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: proof });
		assert.equal(first.ok, true);
		const publishedAt = manager.getJob(launch.jobId)?.payloadUpdatedAt;
		await assert.rejects(
			() => manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: proof }),
			/already accepted a YAML submission/,
		);
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "ready");
		assert.equal(job?.payloadUpdatedAt, publishedAt);
	});

	it("submit-yaml rejects SHA mismatches against authoritative launch bundle metadata", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const mismatch = await manager.submitYaml({
			sessionId: launch.childSessionId,
			jobId: launch.jobId,
			yaml: validYaml(42, { baseSha: "ccccccc", headSha: fixture.headSha.slice(0, 7) }),
			submissionProof: submitProof(sessionManager, launch.childSessionId),
		});
		assert.equal(mismatch.ok, false);
		assert.equal(mismatch.status, "validation_failed");
		const mismatchMessage = mismatch.validation.errors.map(error => `${error.path}: ${error.message}`).join("\n");
		assert.match(mismatchMessage, /\$\.pr\.base_sha: Must match (the authoritative PR|launch target) base SHA/);
		assert.equal(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")), false);

		const accepted = await manager.submitYaml({
			sessionId: launch.childSessionId,
			jobId: launch.jobId,
			yaml: validYaml(42, { baseSha: fixture.baseSha.slice(0, 7), headSha: fixture.headSha.slice(0, 7) }),
			submissionProof: submitProof(sessionManager, launch.childSessionId),
		});
		assert.equal(accepted.ok, true);
		const stored = getWalkthrough(launch.changesetId, tempDir);
		assert.equal(stored?.changeset.baseSha, fixture.baseSha);
		assert.equal(stored?.changeset.headSha, fixture.headSha);
	});

	it("internal submit accepts valid YAML with the real schema mapper and terminates the child session", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, true);
		assert.equal(result.status, "ready");
		assert.ok(sessionManager.terminated.includes(launch.childSessionId), "submitting a walkthrough must terminate the child session");
		const job = manager.getJob(launch.jobId);
		assert.equal(job?.status, "ready");
		assert.ok(job?.submittedAt);
		assert.ok(fs.existsSync(path.join(tempDir, "pr-walkthrough", "v1")));
		assert.deepEqual(result.warnings.filter(warning => warning.code === "yaml-fallback-mapper"), []);
	});

	it("submitting valid YAML terminates the walkthrough child session", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, true);
		assert.equal(result.status, "ready");
		assert.ok(sessionManager.terminated.includes(launch.childSessionId), "submitting a walkthrough must terminate the child session");
	});

	it("terminal runtime failure terminates the walkthrough child session", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		sessionManager.sessions.get(launch.childSessionId).emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model stream crashed" } });
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.equal(manager.getJob(launch.jobId)?.status, "error");
		assert.ok(sessionManager.terminated.includes(launch.childSessionId), "a terminal runtime failure must terminate the child session");
	});

	it("non-terminal validation failures do NOT terminate the walkthrough child session", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

		const result = await manager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: "schema_version: 1\n", submissionProof: submitProof(sessionManager, launch.childSessionId) });
		assert.equal(result.ok, false);
		assert.equal(result.status, "validation_failed");
		assert.equal(sessionManager.terminated.includes(launch.childSessionId), false, "validation_failed is non-terminal — the agent retries in the same live session");
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

	it("submit-yaml maps against the stored launch bundle without submit-time diff resolution", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const launchManager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		const launch = await launchManager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		const proof = submitProof(sessionManager, launch.childSessionId);
		const submitManager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store,
			resolveDiffForYamlMapping: () => { throw new Error("submit-time resolver called; expected stored PR walkthrough analysis bundle"); },
		});

		const result = await submitManager.submitYaml({ sessionId: launch.childSessionId, jobId: launch.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }), submissionProof: proof });

		assert.equal(result.ok, true);
		const stored = getWalkthrough(launch.changesetId, tempDir);
		assert.equal(stored?.changeset.baseSha, fixture.baseSha);
		assert.equal(stored?.changeset.headSha, fixture.headSha);
	});

	it("missing stored analysis bundle returns a deterministic retryable submission error instead of re-resolving diff data", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await callRoute(manager, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		const proof = submitProof(sessionManager, launch.body.childSessionId);
		removeAnalysisBundleArtifacts();

		const result = await callRoute(manager, "POST", "/api/internal/pr-walkthrough/submit-yaml", { sessionId: launch.body.childSessionId, jobId: launch.body.jobId, yaml: validYaml(42, { baseSha: fixture.baseSha, headSha: fixture.headSha }) }, {}, { "x-bobbit-walkthrough-submit-proof": proof });

		assert.notEqual(result.status, 200, "missing bundle must not be silently recovered by submit-time GitHub/local diff resolution");
		assert.equal(result.body.code, "PR_WALKTHROUGH_BUNDLE_MISSING");
		assert.equal(result.body.retryable, true);
		assert.match(result.body.message, /bundle/i);
	});

	it("github submit without analysis bundle metadata fails before custom or submit-time diff fallback", async () => {
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const proof = "scoped-proof";
		store.create({
			jobId: "job-no-bundle-metadata",
			parentSessionId: "parent",
			childSessionId: "child-no-bundle-metadata",
			cwd: tempDir,
			target: { provider: "github", canonicalKey: "github:acme/widgets#42", owner: "acme", repo: "widgets", number: 42, prUrl: "https://github.com/acme/widgets/pull/42", baseSha: "abcdef1", headSha: "1234567" },
			changesetId: "github:acme/widgets#42",
			tabId: "walkthrough:github:acme/widgets#42",
			status: "waiting_for_yaml",
			title: "PR #42 Walkthrough",
			submissionProofHash: submitProofHash("job-no-bundle-metadata", "child-no-bundle-metadata", proof),
		});
		sessionManager.sessions.set("child-no-bundle-metadata", { id: "child-no-bundle-metadata", cwd: tempDir, status: "idle" });
		const manager = new WalkthroughAgentManager({
			defaultCwd: tempDir,
			stateDir: tempDir,
			sessionManager,
			store,
			resolveDiffForYamlMapping: () => { throw new Error("custom submit-time resolver should not be called"); },
		});

		await assert.rejects(
			() => manager.submitYaml({ sessionId: "child-no-bundle-metadata", jobId: "job-no-bundle-metadata", yaml: validYaml(), submissionProof: proof }),
			/PR walkthrough analysis bundle is missing or unusable/,
		);
		const job = manager.getJob("job-no-bundle-metadata");
		assert.equal(job?.status, "error");
		assert.equal(job?.error?.code, "PR_WALKTHROUGH_BUNDLE_MISSING");
		assert.equal(job?.error?.retryable, true);
		// Terminal error: a mapping/diff-resolution failure flips the job to status:"error"
		// (reapable on boot), so the live child must be torn down too — otherwise the
		// process leaks until the next restart.
		assert.ok(sessionManager.terminated.includes("child-no-bundle-metadata"), "a terminal mapping error must terminate the child session");
		assert.equal(sessionManager.sessions.has("child-no-bundle-metadata"), false, "terminated child is removed from the live session map");
	});

	it("internal submit validates YAML identity against the launch target", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

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

	it("route rejects local agent launches with a structured error", async () => {
		const sessionManager = makeSessionManager();
		const result = await callRoute(undefined as any, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", baseSha: "abcdef1", headSha: "1234567" }, { sessionManager, broadcast: () => undefined });
		assert.equal(result.status, 400);
		assert.equal(result.body.code, "LOCAL_WALKTHROUGH_AGENT_UNSUPPORTED");
	});

	it("route constructs a stable manager across fresh dependency objects", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const body = { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha };
		const first = await callRoute(undefined as any, "POST", "/api/pr-walkthrough/launch", body, { sessionManager, broadcast: () => undefined });
		const second = await callRoute(undefined as any, "POST", "/api/pr-walkthrough/launch", body, { sessionManager, broadcast: () => undefined });
		assert.equal(first.status, 201);
		assert.equal(second.status, 200);
		assert.equal(second.body.childSessionId, first.body.childSessionId);
	});

	it("restore reattaches idle-reminder listeners for non-ready jobs", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const store = new WalkthroughAgentStore(tempDir);
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		const restoredManager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store });
		restoredManager.restore();
		sessionManager.sessions.get(launch.childSessionId).emit({ type: "agent_end" });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.match(sessionManager.prompts.at(-1) ?? "", /went idle without publishing|submit_pr_walkthrough_yaml/);
	});

	it("route constructs the production manager with SessionManager and broadcast dependencies", async () => {
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const events: Record<string, unknown>[] = [];
		const res = makeResponse();
		const handled = await handlePrWalkthroughApiRoute(new URL("http://localhost/api/pr-walkthrough/launch"), { method: "POST" } as any, res as any, {
			defaultCwd: tempDir,
			stateDir: tempDir,
			readBody: async () => ({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha }),
			sessionManager,
			broadcast: event => events.push(event),
		});
		assert.equal(handled, true);
		assert.equal(res.status, 201);
		const body = JSON.parse(res.body ?? "{}");
		assert.equal(body.status, "waiting_for_yaml");
		assert.equal(body.tabId, `walkthrough:${encodeURIComponent(body.changesetId)}`);
		assert.equal(body.job.tabId, `walkthrough:${encodeURIComponent(body.changesetId)}`);
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
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await callRoute(manager, "POST", "/api/pr-walkthrough/launch", { sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });

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
		const fixture = createGitDiffFixture();
		const sessionManager = makeSessionManager();
		const manager = new WalkthroughAgentManager({ defaultCwd: tempDir, stateDir: tempDir, sessionManager, store: new WalkthroughAgentStore(tempDir) });
		const launch = await manager.launch({ sessionId: "parent", prUrl: "https://github.com/acme/widgets/pull/42", baseSha: fixture.baseSha, headSha: fixture.headSha });
		await assert.rejects(
			() => manager.submitYaml({ sessionId: "other-session", jobId: launch.jobId, yaml: validYaml(), submissionProof: submitProof(sessionManager, launch.childSessionId) }),
			/error|not allowed/i,
		);
	});
});

describe("SessionManager.terminateSession cascade to pr-walkthrough children", () => {
	let stateRoot = "";
	let prevBobbitDir: string | undefined;
	const managers: any[] = [];

	beforeEach(() => {
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prw-cascade-"));
		prevBobbitDir = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = stateRoot;
	});

	afterEach(() => {
		while (managers.length > 0) {
			const m = managers.pop();
			if (m?._statusHeartbeatTimer) { clearInterval(m._statusHeartbeatTimer); m._statusHeartbeatTimer = null; }
			m?.sessions?.clear?.();
		}
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(stateRoot, { recursive: true, force: true });
	});

	function makeInfo(store: InstanceType<typeof SessionStore>, id: string, extra: Record<string, any>): any {
		const persisted = {
			id,
			title: id,
			cwd: stateRoot,
			agentSessionFile: "",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			...extra,
		};
		store.put(persisted as any);
		return {
			id,
			title: id,
			cwd: stateRoot,
			status: "idle",
			statusVersion: 0,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			rpcClient: { getState: async () => ({ success: true }), stop: async () => {}, onEvent: () => () => {} },
			unsubscribe: () => {},
			...extra,
		};
	}

	it("terminating the parent cascades to its in-memory pr-walkthrough child", async () => {
		const store = new SessionStore(stateRoot);
		const manager: any = new SessionManager();
		manager._testStore = store;
		managers.push(manager);

		manager.sessions.set("parent", makeInfo(store, "parent", {}));
		manager.sessions.set("prw-child", makeInfo(store, "prw-child", { childKind: "pr-walkthrough", parentSessionId: "parent" }));

		await manager.terminateSession("parent");

		assert.equal(manager.sessions.has("parent"), false, "parent must be terminated");
		assert.equal(manager.sessions.has("prw-child"), false, "pr-walkthrough child must be cascade-terminated");
		assert.equal(store.get("prw-child")?.archived, true, "cascade-terminated child must be archived (not respawned on boot)");
	});

	it("archives a persisted-but-not-in-memory pr-walkthrough child when its parent is terminated", async () => {
		const store = new SessionStore(stateRoot);
		const manager: any = new SessionManager();
		manager._testStore = store;
		managers.push(manager);

		manager.sessions.set("parent", makeInfo(store, "parent", {}));
		// child exists only in the store (dormant), not in the in-memory map
		store.put({ id: "prw-dormant", title: "prw-dormant", cwd: stateRoot, agentSessionFile: "", createdAt: Date.now(), lastActivity: Date.now(), childKind: "pr-walkthrough", parentSessionId: "parent" } as any);

		await manager.terminateSession("parent");

		assert.equal(store.get("prw-dormant")?.archived, true, "persisted-only pr-walkthrough child must be archived with its parent");
	});

	it("terminating a sandboxed pr-walkthrough child does NOT remove the shared parent worktree", async () => {
		const store = new SessionStore(stateRoot);
		const manager: any = new SessionManager();
		manager._testStore = store;
		managers.push(manager);

		const removed: string[] = [];
		const sandbox = { removeWorktree: async (name: string) => { removed.push(name); } };
		manager.sandboxManager = { get: () => sandbox };

		// prw child is sandboxed and shares the parent's /workspace-wt/<name> cwd.
		manager.sessions.set("prw-child", makeInfo(store, "prw-child", {
			childKind: "pr-walkthrough",
			parentSessionId: "parent",
			sandboxed: true,
			projectId: "project-1",
			cwd: "/workspace-wt/shared-branch",
		}));

		await manager.terminateSession("prw-child");

		assert.equal(manager.sessions.has("prw-child"), false, "prw child must still be terminated");
		assert.deepEqual(removed, [], "terminating a prw child must NOT remove the parent's shared sandbox worktree");
	});
});

describe("shouldReapWalkthroughChildOnBoot", () => {
	const liveParent = { parentExists: true, parentArchived: false };

	it("reaps a terminal (ready) walkthrough job", () => {
		const decision = shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus: "ready", ...liveParent });
		assert.equal(decision.reap, true);
		assert.match(decision.reason ?? "", /terminal/);
	});

	it("reaps a terminal (error) walkthrough job", () => {
		const decision = shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus: "error", ...liveParent });
		assert.equal(decision.reap, true);
		assert.match(decision.reason ?? "", /terminal/);
	});

	it("reaps when the walkthrough job record is missing", () => {
		assert.equal(shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus: undefined, ...liveParent }).reap, true);
		assert.equal(shouldReapWalkthroughChildOnBoot({ walkthroughJobId: undefined, parentSessionId: "parent", jobStatus: "waiting_for_yaml", ...liveParent }).reap, true);
	});

	it("reaps an orphan whose parent no longer exists", () => {
		const decision = shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus: "waiting_for_yaml", parentExists: false, parentArchived: false });
		assert.equal(decision.reap, true);
		assert.match(decision.reason ?? "", /parent/);
	});

	it("reaps an orphan whose parent is archived", () => {
		const decision = shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus: "validation_failed", parentExists: true, parentArchived: true });
		assert.equal(decision.reap, true);
		assert.match(decision.reason ?? "", /archived/);
	});

	it("reaps when no parent session id is recorded", () => {
		assert.equal(shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: undefined, jobStatus: "waiting_for_yaml", parentExists: false, parentArchived: false }).reap, true);
	});

	it("does NOT reap an in-flight walkthrough with a live, non-archived parent", () => {
		for (const jobStatus of ["starting", "waiting_for_yaml", "validation_failed"]) {
			const decision = shouldReapWalkthroughChildOnBoot({ walkthroughJobId: "job-1", parentSessionId: "parent", jobStatus, ...liveParent });
			assert.equal(decision.reap, false, `in-flight ${jobStatus} with a live parent must restore`);
		}
	});
});
