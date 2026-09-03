/**
 * API E2E — PR walkthrough → host.agents reviewer migration (design
 * docs/design/pr-walkthrough-host-agents-migration.md §3.2 / §7).
 *
 * Drives the pack's `run` + `status` ROUTES through the REAL confined worker
 * (`ModuleHost.invoke`, exportKind:"routes") exactly as the gateway's
 * RouteDispatcher does, wired to the SAME in-process OrchestrationCore + pack
 * store that back the production endpoints. The reviewer child is a real,
 * isolated, read-only `host-agents` session minted by `host.agents.spawn`; its
 * spawn prompt runs the e2e MOCK AGENT (canned / no-LLM), so the child settles
 * idle in milliseconds and this E2E is NON-FLAKY and stays in the e2e phase
 * (NEVER test:manual).
 *
 * The reviewer's `submit_pr_walkthrough_yaml` / `read_pr_walkthrough_bundle`
 * tool calls run in the agent PROCESS and reach the gateway over HTTP, so this
 * spec drives those server endpoints (`/api/internal/pr-walkthrough/{submit-yaml,
 * bundle}`) DIRECTLY with the reviewer child's real `X-Bobbit-Session-Secret`,
 * exercising the same authorization + binding-routing code paths deterministically
 * (the mock agent does not script the walkthrough toolchain).
 *
 * Acceptance rows covered (design §7):
 *   • Run mints a NEW read-only reviewer; owner agent NOT driven.
 *   • Reviewer toolset is exactly the six walkthrough tools.
 *   • Submit authz without a secret: only the bound reviewer submits; routed to
 *     binding[sessionId].jobId; no/wrong secret → 403; unbound → 403; second
 *     submit (terminal) → 409.
 *   • ALWAYS-FRESH (launch-ux §5.2 / Q4): same target twice → TWO distinct live
 *     reviewers (created:true both times); the reviewerKey dedup is GONE.
 *   • No spawn/binding race: immediate read_pr_walkthrough_bundle resolves.
 *   • Status route is binding-authoritative (mismatched jobId/foreign child → error).
 *   • NO AUTO-DISMISS (launch-ux §5.1 / req 3-4; Decision-E regression guard):
 *     submit NEVER dismisses the reviewer + stamps NO childTerminal marker; the
 *     reviewer survives a gateway restart (owner alive) and is reaped ONLY by the
 *     user's terminate/archive control.
 *   • Scope: the pack drives only its own reviewer child.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { test, expect } from "../in-process-harness.js";
import { loadE2EDistServerRuntime } from "../../support/harnesses/e2e/dist-server-runtime.js";
import { apiFetch, createSession, nonGitCwd, waitForSessionStatus } from "../e2e-setup.js";
import { awaitableRm, pollUntil } from "../test-utils/cleanup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");
const PACK_ROOT = resolve(PROJECT_ROOT, "market-packs", "pr-walkthrough");
const ROUTES_MODULE = resolve(PACK_ROOT, "lib", "routes.mjs");
const PACK_ID = "pr-walkthrough";
const REVIEWER_TOOLS = ["readonly_bash", "read_pr_walkthrough_bundle", "submit_pr_walkthrough_chunk", "read_pr_walkthrough_submission_status", "finalize_pr_walkthrough_submission", "submit_pr_walkthrough_yaml"];

// The canonical GitHub target the run route is launched against; matches the
// submitted YAML's `pr` identity so submit-yaml validation passes.
const PR_URL = "https://github.com/SuuBro/bobbit/pull/42";

async function setPrWalkthroughActivation(disabled: Record<string, unknown>): Promise<any> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return JSON.parse(text);
}

// ── git fixture (a real local repo so the bundle endpoint's live recompute
//    resolves; mirrors pr-walkthrough-api.spec.ts::makeGitFixture). ──
type GitFixture = { cwd: string; baseSha: string; headSha: string; cleanup: () => void };
const fixtureRoots = new Set<string>();
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function makeGitFixture(): GitFixture {
	const cwd = mkdtempSync(join(nonGitCwd(), "bobbit-prw-ha-"));
	git(cwd, ["init"]);
	git(cwd, ["config", "user.name", "Bobbit E2E"]);
	git(cwd, ["config", "user.email", "bobbit-e2e@example.test"]);
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "base"]);
	const baseSha = git(cwd, ["rev-parse", "HEAD"]);
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\nSecond line\n", "utf-8");
	writeFileSync(join(cwd, "src", "feature.ts"), "export const answer = 42;\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "head"]);
	const headSha = git(cwd, ["rev-parse", "HEAD"]);
	// Queue removal until after child-before-owner session purge. Removing the
	// primary repository while linked worktrees are live corrupts their .git
	// indirection and turns later setup/teardown failures into misleading ENOENTs.
	const cleanup = () => { fixtureRoots.add(cwd); };
	return { cwd, baseSha, headSha, cleanup };
}

// Valid production YAML matching the SuuBro/bobbit#42 launch identity. Ported
// from tests/pr-walkthrough-yaml-schema.test.ts::validYaml so submit validation
// passes; SHAs are substituted to the git fixture's real commits at call time.
function buildValidYaml(baseSha: string, headSha: string): string {
	return `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Fix confusing walkthrough launch
  url: ${PR_URL}
  base_sha: ${baseSha}
  head_sha: ${headSha}
  original_description:
    body: |-
      ## Why
      Fixes review scope.
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 2
    additions: 10
    deletions: 3
walkthrough:
  context:
    why_created: Fix the walkthrough launch flow.
    problem_solved: Reviewers need session-hosted context.
    why_worth_merging: It makes review safer.
    merge_concerns: Validate session wiring separately.
    author_intent: Move synthesis into the agent.
    reviewer_map: Start with API chunk, then audit.
  merge_assessment:
    recommendation: comment
    confidence: medium
    summary: Good direction with follow-up checks.
    blocking_concerns: []
    non_blocking_concerns:
      - Confirm reload persistence.
  design_decisions:
    - id: design-agent-yaml
      title: Agent submits YAML
      explanation: A dedicated tool gates panel population.
      chosen_approach: Validate and map submitted YAML server-side.
      alternatives_considered: []
      tradeoffs:
        - Requires a schema mapper.
      suggested_reviewer_concerns:
        - Does invalid YAML stay retryable?
      relevant_hunks: []
  review_chunks:
    - id: chunk-readme
      phase: significant
      title: README narrative update
      reviewer_goal: Decide whether the narrative change reads well.
      explanation: The README gains a second narrative line.
      files:
        - README.md
      relevant_hunks: []
      suggested_concerns: []
      positive_notes:
        - Clear narrative addition
    - id: chunk-audit
      phase: audit
      title: Audit leftovers
      reviewer_goal: Check no files were skipped.
      explanation: Audit remaining generated or mechanical changes.
      files: []
      relevant_hunks: []
      suggested_concerns: []
      positive_notes: []
  omissions_and_followups: []
  audit:
    remaining_changed_areas:
      - Session metadata integration.
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm no tests were run by the analyser.
  display:
    phase_order:
      - orientation
      - design
      - significant
      - other
      - audit
    chunk_order:
      - chunk-readme
      - chunk-audit
`;
}

test.describe("PR walkthrough → host.agents reviewer (API E2E)", () => {
	// These journeys intentionally share one worker-scoped gateway/ModuleHost.
	// Serial mode prevents fullyParallel from recreating that host lifecycle.
	test.describe.configure({ mode: "serial" });

	let moduleHost: any;
	let ModuleHostClass: any;
	let createServerHostApi: any;
	let getPackStore: any;
	const createdSessionIds = new Set<string>();

	test.beforeAll(async () => {
		const enabled = await setPrWalkthroughActivation({
			enabled: true,
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
		});
		expect(enabled.disabled.enabled).toBe(true);

		const runtime = await loadE2EDistServerRuntime(async () => ({
			moduleHostWorker: await import("../../../dist/server/extension-host/module-host-worker.js"),
			serverHostApi: await import("../../../dist/server/extension-host/server-host-api.js"),
			packStore: await import("../../../dist/server/extension-host/pack-store.js"),
		}));
		ModuleHostClass = runtime.moduleHostWorker.ModuleHost;
		createServerHostApi = runtime.serverHostApi.createServerHostApi;
		getPackStore = runtime.packStore.getPackStore;
		// ONE shared ModuleHost for the gateway-process lifetime, mirroring how
		// server.ts constructs a single RouteDispatcher/ModuleHost.
		moduleHost = new ModuleHostClass({ timeoutMs: 30_000 });
	});

	test.afterAll(async () => {
		try {
			moduleHost?.dispose();
		} finally {
			const cleared = await setPrWalkthroughActivation({});
			expect(cleared.disabled.enabled).toBeUndefined();
		}
	});

	test.afterEach(async ({ gateway }) => {
		const cleanupErrors: string[] = [];
		const pending = [...createdSessionIds];
		createdSessionIds.clear();
		const depth = (id: string): number => {
			let current = gateway.sessionManager.getPersistedSession(id);
			let value = 0;
			const seen = new Set<string>([id]);
			while (typeof current?.parentSessionId === "string" && pending.includes(current.parentSessionId) && !seen.has(current.parentSessionId)) {
				seen.add(current.parentSessionId);
				value++;
				current = gateway.sessionManager.getPersistedSession(current.parentSessionId);
			}
			return value;
		};

		// Depth ordering is the cleanup invariant: every child is purged before
		// its owner regardless of creation order, duplicate tracking, or failures.
		for (const id of pending.sort((a, b) => depth(b) - depth(a))) {
			try {
				const persisted = gateway.sessionManager.getPersistedSession(id);
				const worktreePaths = new Set<string>();
				if (typeof persisted?.worktreePath === "string") worktreePaths.add(persisted.worktreePath);
				for (const value of Object.values(persisted?.repoWorktrees ?? {})) {
					if (typeof value === "string") worktreePaths.add(value);
					else if (value && typeof value === "object") {
						const candidate = (value as any).worktreePath ?? (value as any).path;
						if (typeof candidate === "string") worktreePaths.add(candidate);
					}
				}
				if (gateway.sessionManager.getArchivedSession(id) && gateway.sessionManager.getSession(id)) {
					const terminated = await gateway.sessionManager.terminateSession(id);
					if (!terminated) cleanupErrors.push(`terminate split archived/live session ${id}`);
				}
				const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}?purge=true`, { method: "DELETE" });
				const text = await response.text();
				if (response.status !== 200) cleanupErrors.push(`purge session ${id}: ${response.status} ${text}`);
				else {
					await pollUntil(() => {
						const absent = !gateway.sessionManager.getSession(id)
							&& !gateway.sessionManager.getPersistedSession(id)
							&& [...worktreePaths].every((worktreePath) => !existsSync(worktreePath));
						return absent ? true : null;
					}, { timeoutMs: 10_000, intervalMs: 50, label: `session ${id} purge` });
				}
			} catch (error) {
				cleanupErrors.push(`purge session ${id}: ${String(error)}`);
			}
		}
		for (const root of fixtureRoots) {
			try {
				const cleanup = await awaitableRm(root);
				if (!cleanup.removed) cleanupErrors.push(`remove PR walkthrough fixture ${root}: ${String(cleanup.lastError ?? "unknown error")}`);
			} catch (error) {
				cleanupErrors.push(`remove PR walkthrough fixture ${root}: ${String(error)}`);
			} finally {
				fixtureRoots.delete(root);
			}
		}
		expect(cleanupErrors, cleanupErrors.join("\n")).toEqual([]);
	});

	function buildHost(gateway: any, ownerId: string): any {
		return createServerHostApi({
			sessionId: ownerId,
			packId: PACK_ID,
			contributionId: "pr-walkthrough/run",
			packStore: getPackStore(),
			orchestrationCore: gateway.orchestrationCore,
			readChildStatus: (id: string) => gateway.sessionManager.getSession(id)?.status,
		});
	}

	/** Invoke a pack route exactly as the gateway RouteDispatcher does. */
	async function invokeRoute(gateway: any, ownerId: string, member: string, req: any, workingDir: string): Promise<any> {
		const host = buildHost(gateway, ownerId);
		return await moduleHost.invoke({
			url: pathToFileURL(ROUTES_MODULE).href,
			packRoot: PACK_ROOT,
			epoch: 0,
			exportKind: "routes",
			member,
			ctx: { host, sessionId: ownerId, toolUseId: "tu-prw", tool: `pr-walkthrough/${member}`, workingDir },
			arg: req,
		});
	}

	async function invokeReadyRun(gateway: any, ownerId: string, req: any, workingDir: string): Promise<any> {
		await waitForSessionStatus(ownerId, "idle");
		const result = await invokeRoute(gateway, ownerId, "run", req, workingDir);
		expect(result, `run route failed: ${JSON.stringify(result)}`).toMatchObject({ ok: true, created: true });
		expect(typeof result.childSessionId).toBe("string");
		createdSessionIds.add(result.childSessionId);
		await waitForSessionStatus(result.childSessionId, "idle");
		return result;
	}

	const runReq = (fixture: GitFixture) => ({
		method: "POST",
		body: { prUrl: PR_URL, baseSha: fixture.baseSha, headSha: fixture.headSha },
	});

	/** The conversation messages the in-process mock agent recorded for a session.
	 *  A never-prompted session's mock agent process is not running, so getMessages
	 *  throws — which is itself proof the session was never driven (→ 0 messages). */
	async function sessionMessages(gateway: any, sessionId: string): Promise<any[]> {
		const rpc = gateway.sessionManager.getSession(sessionId)?.rpcClient;
		if (!rpc?.getMessages) return [];
		try {
			const res = await rpc.getMessages();
			const data = res?.data?.messages ?? res?.data ?? [];
			return Array.isArray(data) ? data : [];
		} catch {
			return []; // agent process never started ⇒ never driven
		}
	}

	function reviewerSecret(gateway: any, childSessionId: string): string {
		return gateway.sessionManager.sessionSecretStore.getOrCreateSecret(childSessionId);
	}

	/**
	 * Inspect the ACTUAL tool-guard extension(s) the gateway generated for a
	 * spawned child and return the set of tool names the guard hard-blocks (its
	 * `neverPolicies` keys). The guard file paths are the `--extension` args the
	 * gateway pushed onto the child's RpcBridge in `session-setup`
	 * (`_resolveToolActivation` → `writeToolGuardExtension`). Reading them back is
	 * the most faithful observation of the bug: pre-fix the walkthrough tools
	 * were stamped into `neverPolicies` (every call → "not permitted for
	 * this role"); the fix resolves the pack role so they are not.
	 */
	function childGuardNeverNames(gateway: any, childSessionId: string): { neverNames: Set<string>; guardFiles: number } {
		const args: string[] = (gateway.sessionManager.getSession(childSessionId)?.rpcClient as any)?.options?.args ?? [];
		const neverNames = new Set<string>();
		let guardFiles = 0;
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] !== "--extension") continue;
			const p = args[i + 1];
			if (typeof p !== "string" || !/tool-guard/.test(p)) continue;
			let code: string;
			try { code = readFileSync(p, "utf-8"); } catch { continue; }
			guardFiles++;
			const m = code.match(/const neverPolicies = (\{.*?\});/s);
			if (!m) continue;
			for (const k of Object.keys(JSON.parse(m[1]))) neverNames.add(k);
		}
		return { neverNames, guardFiles };
	}

	// Journey 1: one real reviewer lifetime covers spawn isolation, tool/prompt
	// resolution, immediate bundle routing, submission authorization, bound status
	// and recovery, persistence after submit, and explicit user termination.
	test("reviewer lifecycle preserves spawn, route, auth, submission, recovery, and termination boundaries", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		const foreign = await createSession({ cwd: fixture.cwd });
		createdSessionIds.add(owner);
		createdSessionIds.add(foreign);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		try {
			let started: any;
			let child = "";
			let secret = "";

			await test.step("run isolation, exact tools, prompt, and immediate bundle", async () => {
				expect(await sessionMessages(gateway, owner)).toHaveLength(0);
				started = await invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd);
				child = started.childSessionId;
				secret = reviewerSecret(gateway, child);
				expect(typeof started.jobId).toBe("string");

				const persisted = gateway.sessionManager.getPersistedSession(child);
				expect(persisted).toMatchObject({
					parentSessionId: owner,
					childKind: "host-agents",
					readOnly: true,
					role: "pr-reviewer",
					accessory: "magnifier",
					title: "PR Walkthrough",
				});
				const toolset = new Set<string>(persisted?.allowedTools ?? []);
				expect([...toolset].sort()).toEqual([...REVIEWER_TOOLS].sort());
				for (const t of ["write", "edit", "bash", "team_spawn", "team_delegate", "task_create", "gate_signal"]) {
					expect(toolset.has(t), `read-only reviewer must NOT have ${t}`).toBe(false);
				}

				const { neverNames, guardFiles } = childGuardNeverNames(gateway, child);
				expect(guardFiles, "a tool-guard extension must be generated for the reviewer").toBeGreaterThan(0);
				expect(neverNames.has("write"), "the read-only reviewer guard must block write").toBe(true);
				for (const t of REVIEWER_TOOLS) {
					expect(neverNames.has(t), `guard must NOT hard-block ${t}`).toBe(false);
				}
				const rolePrompt = String(gateway.sessionManager.getPromptParts(child)?.rolePrompt ?? "");
				expect(rolePrompt).toContain("schema_version");
				expect(rolePrompt).toContain("merge_assessment");

				await pollUntil(async () => {
					const messages = await sessionMessages(gateway, child);
					return messages.some((message) => message.role === "user" && JSON.stringify(message.content ?? "").includes("Review target")) ? true : null;
				}, { timeoutMs: 10_000, intervalMs: 50, label: "reviewer received kickoff" });
				expect(await sessionMessages(gateway, owner)).toHaveLength(0);

				const reviewerIndex = await getPackStore().get(PACK_ID, `reviewers/${child}`);
				expect(reviewerIndex?.jobId).toBe(started.jobId);
				const scopedBinding = await getPackStore().get(PACK_ID, `reviews/${started.jobId}/binding/${child}`);
				expect(scopedBinding?.jobId).toBe(started.jobId);
				expect(await getPackStore().get(PACK_ID, `binding/${child}`)).toBeNull();

				// This is deliberately the first route after run: the deferred prompt
				// must make the binding visible before any status polling can race it.
				const bundle = await apiFetch("/api/internal/pr-walkthrough/bundle", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": secret },
					body: JSON.stringify({ mode: "manifest" }),
				});
				expect(bundle.status, await bundle.clone().text().catch(() => "")).toBe(200);
				expect(JSON.stringify(await bundle.json())).toContain("README.md");
			});

			await test.step("secret and binding authorization fail closed", async () => {
				const noSecret = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					body: JSON.stringify({ yaml }),
				});
				expect(noSecret.status).toBe(403);

				const wrongSecret = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": "not-a-real-secret" },
					body: JSON.stringify({ yaml }),
				});
				expect(wrongSecret.status).toBe(403);

				const unbound = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, owner) },
					body: JSON.stringify({ yaml }),
				});
				expect(unbound.status).toBe(403);
				expect((await unbound.json()).code).toBe("WALKTHROUGH_NOT_BOUND");

				const mismatch = await invokeRoute(gateway, owner, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: "prw-some-other-job" },
				}, fixture.cwd);
				expect(mismatch.phase).toBe("error");
				expect(mismatch.yaml).toBeUndefined();

				const ownerAsChild = await invokeRoute(gateway, owner, "status", {
					method: "POST",
					body: { childSessionId: owner, jobId: started.jobId },
				}, fixture.cwd);
				expect(ownerAsChild.phase).toBe("error");

				const childWrongJob = await invokeRoute(gateway, child, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: "prw-not-the-bound-job" },
				}, fixture.cwd);
				expect(childWrongJob.phase).toBe("error");
				expect(childWrongJob.error).toMatch(/unknown or mismatched binding/);
				expect(childWrongJob.yaml).toBeUndefined();

				const foreignStatus = await invokeRoute(gateway, foreign, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: started.jobId },
				}, fixture.cwd);
				expect(foreignStatus.phase).toBe("error");
				expect(foreignStatus.error).toMatch(/unknown or mismatched binding/);
				expect(foreignStatus.yaml).toBeUndefined();
			});

			await test.step("bound child and owner status route the correct job", async () => {
				const childBeforeSubmit = await invokeRoute(gateway, child, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: started.jobId },
				}, fixture.cwd);
				expect(childBeforeSubmit).toMatchObject({ phase: "running" });
				expect(childBeforeSubmit.yaml).toBeUndefined();
				expect(childBeforeSubmit.error).toBeUndefined();
				const bindingAfterChildPoll = await getPackStore().get(PACK_ID, `binding/${child}`);
				expect(bindingAfterChildPoll?.status).not.toBe("error");

				const ownerBeforeSubmit = await invokeRoute(gateway, owner, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: started.jobId },
				}, fixture.cwd);
				expect(["running", "submitted"]).toContain(ownerBeforeSubmit.phase);
			});

			await test.step("valid and duplicate submissions preserve live reviewer state", async () => {
				const submittedResponse = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": secret },
					body: JSON.stringify({ yaml }),
				});
				expect(submittedResponse.status).toBe(200);
				expect(await submittedResponse.json()).toMatchObject({ ok: true, status: "submitted", jobId: started.jobId });
				expect((await getPackStore().get(PACK_ID, `submitted/${started.jobId}`))?.yaml).toBe(yaml);

				const duplicate = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": secret },
					body: JSON.stringify({ yaml }),
				});
				expect(duplicate.status).toBe(409);
				expect((await duplicate.json()).code).toBe("WALKTHROUGH_ALREADY_READY");
				expect((await getPackStore().get(PACK_ID, `submitted/${started.jobId}`))?.yaml).toBe(yaml);

				// A separately bound live child with a pre-existing terminal marker
				// rejects before YAML revalidation, retaining that independent guard.
				const terminalStarted = await invokeReadyRun(gateway, owner, {
					method: "POST",
					body: { prUrl: "https://github.com/SuuBro/bobbit/pull/43", baseSha: fixture.baseSha, headSha: fixture.headSha },
				}, fixture.cwd);
				await getPackStore().put(PACK_ID, `submitted/${terminalStarted.jobId}`, {
					yaml,
					baseSha: fixture.baseSha,
					headSha: fixture.headSha,
					submittedAt: Date.now(),
				});
				const terminal = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, terminalStarted.childSessionId) },
					body: JSON.stringify({ yaml }),
				});
				expect(terminal.status).toBe(409);

				const persisted = gateway.sessionManager.getPersistedSession(child);
				expect(gateway.orchestrationCore.list(owner).some((entry: any) => entry.sessionId === child)).toBe(true);
				expect(gateway.sessionManager.getArchivedSession?.(child)).toBeFalsy();
				expect(persisted).toBeTruthy();
				expect(persisted?.childTerminal).toBeFalsy();
				expect(persisted?.terminalAt).toBeFalsy();
			});

			await test.step("owner and child recover submitted data without foreign leakage", async () => {
				const ownerStatus = await invokeRoute(gateway, owner, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: started.jobId },
				}, fixture.cwd);
				expect(ownerStatus).toMatchObject({ phase: "submitted", yaml });

				const childStatus = await invokeRoute(gateway, child, "status", {
					method: "POST",
					body: { childSessionId: child, jobId: started.jobId },
				}, fixture.cwd);
				expect(childStatus).toMatchObject({ phase: "submitted", yaml });

				const childRecover = await invokeRoute(gateway, child, "recover", { method: "POST", body: {} }, fixture.cwd);
				expect(childRecover).toMatchObject({ found: true, jobId: started.jobId, yaml });
				const foreignRecover = await invokeRoute(gateway, foreign, "recover", { method: "POST", body: {} }, fixture.cwd);
				expect(foreignRecover.found).toBe(false);
				expect(foreignRecover.yaml).toBeUndefined();
				expect(gateway.orchestrationCore.list(owner).some((entry: any) => entry.sessionId === child)).toBe(true);
			});

			await test.step("user session termination archives the post-submit reviewer", async () => {
				const response = await apiFetch(`/api/sessions/${child}`, { method: "DELETE" });
				expect(response.status).toBe(200);
				await pollUntil(() => gateway.projectContextManager.getAllLiveSessions().some((session: any) => session.id === child) ? null : true, {
					timeoutMs: 10_000,
					intervalMs: 50,
					label: "reviewer terminated by user",
				});
				expect(gateway.projectContextManager.getAllLiveSessions().some((session: any) => session.id === child)).toBe(false);
				expect(gateway.sessionManager.getArchivedSession?.(child)).toBeTruthy();
			});
		} finally {
			fixture.cleanup();
		}
	});

	// Journey 2: reuse one owner and fixture while preserving both sequential and
	// concurrent freshness plus host.agents sibling filtering.
	test("fresh launches remain distinct and scoped away from sibling delegate children", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.add(owner);
		try {
			const reviewers: any[] = [];
			await test.step("sequential launches of the same target are always fresh", async () => {
				const first = await invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd);
				const second = await invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd);
				reviewers.push(first, second);
				expect(first.created).toBe(true);
				expect(second.created).toBe(true);
				expect(second.childSessionId).not.toBe(first.childSessionId);
				expect(second.jobId).not.toBe(first.jobId);
				expect(gateway.orchestrationCore.list(owner).filter((entry: any) => entry.childKind === "host-agents").map((entry: any) => entry.sessionId).sort())
					.toEqual([first.childSessionId, second.childSessionId].sort());
				expect(await getPackStore().list(PACK_ID, `reviewer/${owner}/`)).toHaveLength(0);
			});

			await test.step("overlapping launches also stay distinct without a dedup index", async () => {
				const [a, b] = await Promise.all([
					invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd),
					invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd),
				]);
				reviewers.push(a, b);
				expect(a.childSessionId).not.toBe(b.childSessionId);
				expect(a.jobId).not.toBe(b.jobId);
				expect(await getPackStore().list(PACK_ID, `reviewer/${owner}/`)).toHaveLength(0);
				const expected = reviewers.map((reviewer) => reviewer.childSessionId).sort();
				const actual = gateway.orchestrationCore.list(owner)
					.filter((entry: any) => entry.childKind === "host-agents")
					.map((entry: any) => entry.sessionId)
					.sort();
				expect(actual).toEqual(expected);
			});

			await test.step("host.agents excludes a sibling delegate and status rejects it", async () => {
				const delegate = await gateway.orchestrationCore.spawn({
					ownerSessionId: owner,
					instructions: "delegate child",
					childKind: "delegate",
				});
				createdSessionIds.add(delegate.sessionId);
				const host = buildHost(gateway, owner);
				const listed = await host.agents.list();
				expect(listed.map((entry: any) => entry.childSessionId).sort())
					.toEqual(reviewers.map((reviewer) => reviewer.childSessionId).sort());
				const status = await invokeRoute(gateway, owner, "status", {
					method: "POST",
					body: { childSessionId: delegate.sessionId, jobId: reviewers[0].jobId },
				}, fixture.cwd);
				expect(status.phase).toBe("error");
			});
		} finally {
			fixture.cleanup();
		}
	});

	// Journey 3: one submitted child pins restart survival and role re-resolution;
	// a separate terminal child proves the generic boot reap remains intact.
	test("restart keeps submitted reviewers resolvable and reaps only childTerminal children", async ({ gateway }) => {
		const runtime = await loadE2EDistServerRuntime(async () => ({
			toolActivation: await import("../../../dist/server/agent/tool-activation.js"),
		}));
		const { resolveGrantPolicy } = runtime.toolActivation;
		const sm: any = gateway.sessionManager;
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.add(owner);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		try {
			let child = "";
			await test.step("submitted reviewer survives the boot-reap decision", async () => {
				const started = await invokeReadyRun(gateway, owner, runReq(fixture), fixture.cwd);
				child = started.childSessionId;
				const submit = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, child) },
					body: JSON.stringify({ yaml }),
				});
				expect(submit.status).toBe(200);

				const persisted = sm.getPersistedSession(child);
				expect(persisted?.childTerminal).toBeFalsy();
				expect(persisted?.parentSessionId).toBe(owner);
				expect(persisted?.childKind).toBe("host-agents");
				const ownerPersisted = sm.getPersistedSession(owner);
				const decision = gateway.orchestrationCore.shouldReapChildOnBoot({
					childKind: persisted?.childKind,
					kindTerminal: persisted?.childTerminal === true,
					ownerSessionId: persisted?.parentSessionId,
					ownerExists: !!ownerPersisted,
					ownerArchived: ownerPersisted?.archived === true,
				});
				expect(decision.reap).toBe(false);
				expect(sm.getArchivedSession?.(child)).toBeFalsy();
				expect(gateway.projectContextManager.getAllLiveSessions().some((session: any) => session.id === child)).toBe(true);
			});

			await test.step("restart role and tool resolution remains pack-aware", async () => {
				const persisted = sm.getPersistedSession(child);
				const groupPolicyStore = sm.groupPolicyStore;
				const restoredRole = sm.resolveSessionRole(persisted?.role, persisted?.assistantType, persisted?.projectId);
				const noProjectRole = sm.resolveSessionRole(persisted?.role, persisted?.assistantType, undefined);
				const unknownRole = sm.resolveSessionRole("prw-e2e-missing-role", persisted?.assistantType, persisted?.projectId);
				expect(restoredRole?.name).toBe("pr-reviewer");
				expect(restoredRole?.toolPolicies?.["PR Walkthrough"]).toBe("allow");
				expect(noProjectRole?.name).toBe("pr-reviewer");
				expect(noProjectRole?.toolPolicies?.["PR Walkthrough"]).toBe("allow");
				expect(unknownRole).toBeUndefined();
				const restoredTemplate = String(sm.resolveRolePromptTemplate(persisted?.role, persisted?.projectId) ?? "");
				expect(restoredTemplate).toContain("schema_version");
				expect(restoredTemplate).toContain("merge_assessment");
				for (const tool of REVIEWER_TOOLS) {
					expect((persisted?.allowedTools ?? []).includes(tool)).toBe(true);
					expect(resolveGrantPolicy(tool, "PR Walkthrough", restoredRole, undefined, groupPolicyStore)).toBe("allow");
					expect(resolveGrantPolicy(tool, "PR Walkthrough", noProjectRole, undefined, groupPolicyStore)).toBe("allow");
					expect(resolveGrantPolicy(tool, "PR Walkthrough", unknownRole, undefined, groupPolicyStore)).toBe("never");
				}
			});

			await test.step("a separate childTerminal child is boot-reaped", async () => {
				const parentProjectId = sm.getPersistedSession(owner)?.projectId;
				const terminalInfo = await sm.createSession(
					sm.getSession(owner)?.cwd,
					undefined, undefined, undefined,
					{ parentSessionId: owner, childKind: "host-agents", readOnly: true, projectId: parentProjectId },
				);
				createdSessionIds.add(terminalInfo.id);
				sm.updateSessionMeta(terminalInfo.id, { childTerminal: true, terminalAt: Date.now() });
				expect(sm.getPersistedSession(terminalInfo.id)?.childTerminal).toBe(true);
				await sm.restoreOneSession(sm.getPersistedSession(terminalInfo.id));
				expect(gateway.projectContextManager.getAllLiveSessions().some((session: any) => session.id === terminalInfo.id)).toBe(false);
			});
		} finally {
			fixture.cleanup();
		}
	});

	// Journey 4: one fixture covers the two launch chokepoints that must reject
	// before any GitHub resolution, publication, or reviewer spawn.
	test("untrusted GitHub and local-only targets fail closed without publish or spawn", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		const reviewer = await createSession({ cwd: fixture.cwd });
		createdSessionIds.add(owner);
		createdSessionIds.add(reviewer);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		const jobId = "prw-untrusted-host-test";
		try {
			await test.step("untrusted GitHub binding rejects bundle and submit", async () => {
				await getPackStore().put(PACK_ID, `binding/${reviewer}`, {
					jobId,
					parentSessionId: owner,
					baseSha: fixture.baseSha,
					headSha: fixture.headSha,
					target: {
						provider: "github",
						prUrl: "https://github.example.com/acme/widgets/pull/42",
						owner: "acme",
						repo: "widgets",
						number: 42,
						host: "github.example.com",
						baseSha: fixture.baseSha,
						headSha: fixture.headSha,
						canonicalKey: "github:github.example.com/acme/widgets#42",
					},
				});
				const secret = reviewerSecret(gateway, reviewer);
				const bundle = await apiFetch("/api/internal/pr-walkthrough/bundle", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": secret },
					body: JSON.stringify({ mode: "manifest" }),
				});
				expect(bundle.status).toBe(403);
				expect((await bundle.json()).code).toBe("untrusted_github_host");
				const submit = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
					method: "POST",
					headers: { "X-Bobbit-Session-Secret": secret },
					body: JSON.stringify({ yaml }),
				});
				expect(submit.status).toBe(403);
				expect((await submit.json()).code).toBe("untrusted_github_host");
				expect(await getPackStore().get(PACK_ID, `submitted/${jobId}`)).toBeFalsy();
			});

			await test.step("local-only run rejects before spawning a reviewer", async () => {
				await waitForSessionStatus(owner, "idle");
				const started = await invokeRoute(gateway, owner, "run", {
					method: "POST",
					body: { baseSha: fixture.baseSha, headSha: fixture.headSha },
				}, fixture.cwd);
				expect(started).toMatchObject({ ok: false, code: "LOCAL_UNSUPPORTED", retryable: false });
				expect(started.childSessionId).toBeUndefined();
				expect(gateway.orchestrationCore.list(owner).filter((entry: any) => entry.childKind === "host-agents")).toHaveLength(0);
			});
		} finally {
			fixture.cleanup();
		}
	});
});
