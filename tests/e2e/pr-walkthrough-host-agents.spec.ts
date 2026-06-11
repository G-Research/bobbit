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
 *   • Reviewer toolset is exactly the three walkthrough tools.
 *   • Submit authz without a secret: only the bound reviewer submits; routed to
 *     binding[sessionId].jobId; no/wrong secret → 403; unbound → 403; second
 *     submit (terminal) → 409.
 *   • Idempotency: same target twice → one reviewer (created:false on the 2nd).
 *   • No spawn/binding race: immediate read_pr_walkthrough_bundle resolves.
 *   • Status route is binding-authoritative (mismatched jobId/foreign child → error).
 *   • Cleanup: submit server-dismisses the reviewer (terminal-synchronous); a
 *     childTerminal boot-reap removes it after a restart with the parent alive.
 *   • Scope: the pack drives only its own reviewer child.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const PACK_ROOT = resolve(PROJECT_ROOT, "market-packs", "pr-walkthrough");
const ROUTES_MODULE = resolve(PACK_ROOT, "lib", "routes.mjs");
const PACK_ID = "pr-walkthrough";
const REVIEWER_TOOLS = ["readonly_bash", "read_pr_walkthrough_bundle", "submit_pr_walkthrough_yaml"];

// The canonical GitHub target the run route is launched against; matches the
// submitted YAML's `pr` identity so submit-yaml validation passes.
const PR_URL = "https://github.com/SuuBro/bobbit/pull/42";

// ── git fixture (a real local repo so the bundle endpoint's live recompute
//    resolves; mirrors pr-walkthrough-api.spec.ts::makeGitFixture). ──
type GitFixture = { cwd: string; baseSha: string; headSha: string; cleanup: () => void };
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function makeGitFixture(): GitFixture {
	const cwd = mkdtempSync(join(tmpdir(), "bobbit-prw-ha-"));
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
	// Best-effort cleanup: on Windows a still-live session whose cwd is this repo
	// (the reviewer child + owner) holds handles, so rmSync can EPERM. The dir is
	// an OS temp dir that the OS reclaims; never fail a test on fixture teardown.
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* OS reclaims */ } };
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
	let moduleHost: any;
	let ModuleHostClass: any;
	let createServerHostApi: any;
	let getPackStore: any;
	const createdSessionIds: string[] = [];

	test.beforeAll(async () => {
		ModuleHostClass = (await import("../../dist/server/extension-host/module-host-worker.js")).ModuleHost;
		createServerHostApi = (await import("../../dist/server/extension-host/server-host-api.js")).createServerHostApi;
		getPackStore = (await import("../../dist/server/extension-host/pack-store.js")).getPackStore;
		// ONE shared ModuleHost for the gateway-process lifetime, mirroring how
		// server.ts constructs a single RouteDispatcher/ModuleHost.
		moduleHost = new ModuleHostClass({ timeoutMs: 30_000 });
	});

	test.afterAll(async () => {
		moduleHost?.dispose();
	});

	test.afterEach(async () => {
		while (createdSessionIds.length) {
			await deleteSession(createdSessionIds.pop()!);
		}
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
	 * the most faithful observation of the bug: pre-fix the three walkthrough
	 * tools were stamped into `neverPolicies` (every call → "not permitted for
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

	// ── Row: Run mints a NEW read-only reviewer; owner agent NOT driven. ──
	test("run mints an isolated read-only pr-reviewer child and never drives the owner agent", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			// Anti-postMessage baseline: the owner's own agent has no transcript yet.
			expect(await sessionMessages(gateway, owner)).toHaveLength(0);

			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			expect(started.ok).toBe(true);
			expect(started.created).toBe(true);
			expect(typeof started.childSessionId).toBe("string");
			expect(typeof started.jobId).toBe("string");
			const child = started.childSessionId;
			createdSessionIds.push(child);

			// The reviewer is a real, visible, read-only host-agents child of the owner.
			const persisted = gateway.sessionManager.getPersistedSession(child);
			expect(persisted?.parentSessionId).toBe(owner);
			expect(persisted?.childKind).toBe("host-agents");
			expect(persisted?.readOnly).toBe(true);
			expect(persisted?.role).toBe("pr-reviewer");
			// The reviewer is minted with the pr-reviewer role's `review` accessory
			// (session-setup applies the resolved role's accessory) — visible in the
			// sidebar, pre-downgrade parity.
			expect(persisted?.accessory).toBe("review");

			// Row: the reviewer's effective toolset. The reviewer carries all three
			// walkthrough tools and read-only is enforced (no write/edit/bash/spawn).
			const toolset = new Set<string>(persisted?.allowedTools ?? []);
			for (const t of REVIEWER_TOOLS) expect(toolset.has(t), `reviewer must have ${t}`).toBe(true);
			for (const t of ["write", "edit", "bash", "team_spawn", "team_delegate", "task_create", "gate_signal"]) {
				expect(toolset.has(t), `read-only reviewer must NOT have ${t}`).toBe(false);
			}
			// The reviewer's effective toolset is EXACTLY the three walkthrough tools:
			// the pr-reviewer role allows the "PR Walkthrough" group and denies every
			// other fixed tool group, so no read/grep/task/gate/etc. leak through.
			expect([...toolset].sort()).toEqual([...REVIEWER_TOOLS].sort());

			// The kickoff was sent to the REVIEWER, not the owner.
			await pollUntil(async () => {
				const msgs = await sessionMessages(gateway, child);
				return msgs.some((m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("Review target")) ? true : null;
			}, { timeoutMs: 10_000, intervalMs: 50, label: "reviewer received kickoff" });

			// The owner agent was never prompted/modified (anti-postMessage assertion).
			expect(await sessionMessages(gateway, owner)).toHaveLength(0);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Submit authz without a secret + right-job routing + idempotent reject. ──
	test("submit-yaml is bound, secret-required, right-job routed, and rejects duplicate/terminal submits", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);
			const secret = reviewerSecret(gateway, child);

			// No secret → 403 (REQUIRED; does not degrade to sandboxScope).
			const noSecret = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				body: JSON.stringify({ yaml }),
			});
			expect(noSecret.status).toBe(403);

			// Wrong secret → 403.
			const wrongSecret = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": "not-a-real-secret" },
				body: JSON.stringify({ yaml }),
			});
			expect(wrongSecret.status).toBe(403);

			// An UNBOUND but otherwise valid session (the owner has no binding) → 403.
			const ownerSecret = reviewerSecret(gateway, owner);
			const unbound = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": ownerSecret },
				body: JSON.stringify({ yaml }),
			});
			expect(unbound.status).toBe(403);
			expect((await unbound.json()).code).toBe("WALKTHROUGH_NOT_BOUND");

			// The bound reviewer's secret routes the YAML to binding[child].jobId.
			const ok = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify({ yaml }),
			});
			expect(ok.status).toBe(200);
			const okBody = await ok.json();
			expect(okBody.ok).toBe(true);
			expect(okBody.jobId).toBe(started.jobId);

			// The submitted-YAML marker landed under the bound jobId.
			const submitted = await getPackStore().get(PACK_ID, `submitted/${started.jobId}`);
			expect(submitted?.yaml).toBe(yaml);

			// A duplicate submit from the SAME reviewer is rejected: the happy-path
			// submit server-dismissed the reviewer (terminal-synchronous reap), which
			// purges its session secret — so re-submitting can no longer authenticate
			// (403). The reviewer can never overwrite its own accepted submission.
			const dup = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify({ yaml }),
			});
			expect([403, 409]).toContain(dup.status);
			// The original submission is untouched by the rejected duplicate.
			expect((await getPackStore().get(PACK_ID, `submitted/${started.jobId}`))?.yaml).toBe(yaml);

			// The genuine 409 TERMINAL guard (the safety net when a dismiss did NOT
			// run): a SECOND, still-live reviewer for a DISTINCT target whose job
			// already carries a submitted marker rejects a fresh submit with 409
			// BEFORE re-validating the YAML.
			const startedB = await invokeRoute(gateway, owner, "run", {
				method: "POST",
				body: { prUrl: "https://github.com/SuuBro/bobbit/pull/43", baseSha: fixture.baseSha, headSha: fixture.headSha },
			}, fixture.cwd);
			expect(startedB.ok).toBe(true);
			const childB = startedB.childSessionId;
			createdSessionIds.push(childB);
			await getPackStore().put(PACK_ID, `submitted/${startedB.jobId}`, { yaml, baseSha: fixture.baseSha, headSha: fixture.headSha, submittedAt: Date.now() });
			const terminal = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, childB) },
				body: JSON.stringify({ yaml }),
			});
			expect(terminal.status).toBe(409);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: an UNTRUSTED GitHub host is rejected on bundle + submit (FINDING 1). ──
	// Restores the legacy launcher's trusted-host chokepoint. The pack `run` route
	// (confined worker) cannot read `githubTrustedHosts`, so the rejection is enforced
	// SERVER-SIDE at the binding-routed bundle + submit-yaml paths — INCLUDING the
	// with-SHA local-recompute path that previously bypassed the github-adapter check.
	// Seeding the binding directly is the most deterministic exercise of the chokepoint.
	test("an untrusted GitHub host 403s on both bundle and submit-yaml (nothing resolved/published)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		// A real session so it has a resolvable X-Bobbit-Session-Secret.
		const reviewer = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(reviewer);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		const jobId = "prw-untrusted-host-test";
		try {
			// GitHub PR on an UNTRUSTED enterprise host, WITH base/head SHAs (the
			// local-recompute path that previously skipped the trusted-host check).
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

			// bundle → 403 untrusted_github_host (nothing resolved).
			const bundle = await apiFetch("/api/internal/pr-walkthrough/bundle", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify({ mode: "manifest" }),
			});
			expect(bundle.status).toBe(403);
			expect((await bundle.json()).code).toBe("untrusted_github_host");

			// submit-yaml → 403 untrusted_github_host (nothing published).
			const submit = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify({ yaml }),
			});
			expect(submit.status).toBe(403);
			expect((await submit.json()).code).toBe("untrusted_github_host");
			// No submitted marker landed for the untrusted job.
			expect(await getPackStore().get(PACK_ID, `submitted/${jobId}`)).toBeFalsy();
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: a LOCAL launch target is rejected by `run` BEFORE any spawn. ──
	// The walkthrough is GitHub-PR-only: the production YAML schema requires
	// `pr.provider: "github"` (PROVIDERS = {github}) and submit-yaml enforces
	// `target.provider === pr.provider`, so a LOCAL-launched reviewer could never
	// submit. The `run` route therefore rejects a `{baseSha,headSha}`-only (local)
	// target up front with `code:"LOCAL_UNSUPPORTED"` and spawns NO reviewer child.
	test("run rejects a local-only target before spawning any reviewer (walkthrough is GitHub-PR-only)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			// A panel-style LOCAL launch (baseSha/headSha only — no prUrl/owner/repo).
			const started = await invokeRoute(gateway, owner, "run", {
				method: "POST",
				body: { baseSha: fixture.baseSha, headSha: fixture.headSha },
			}, fixture.cwd);
			expect(started.ok).toBe(false);
			expect(started.code).toBe("LOCAL_UNSUPPORTED");
			expect(started.retryable).toBe(false);
			expect(started.childSessionId).toBeUndefined();

			// No reviewer child was minted for the owner.
			const reviewers = gateway.orchestrationCore.list(owner).filter((h: any) => h.childKind === "host-agents");
			expect(reviewers).toHaveLength(0);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: No spawn/binding race — immediate bundle read resolves the binding. ──
	test("read_pr_walkthrough_bundle resolves the binding immediately after run (no 403 race)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);
			const secret = reviewerSecret(gateway, child);

			// Drive the bundle endpoint BEFORE any status poll — the deferred-prompt
			// launch guarantees the binding exists, so this must NOT 403.
			const resp = await apiFetch("/api/internal/pr-walkthrough/bundle", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify({ mode: "manifest" }),
			});
			expect(resp.status, `bundle read failed: ${await resp.clone().text().catch(() => "")}`).toBe(200);
			const body = await resp.json();
			// The live recompute resolved a real changeset for the fixture range.
			expect(body).toBeTruthy();
			expect(JSON.stringify(body)).toContain("README.md");
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Idempotency — same target twice → one reviewer. ──
	test("a second run for the same target returns the same reviewer (created:false)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			const first = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			expect(first.ok).toBe(true);
			expect(first.created).toBe(true);
			createdSessionIds.push(first.childSessionId);

			const second = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			expect(second.ok).toBe(true);
			expect(second.created).toBe(false);
			expect(second.childSessionId).toBe(first.childSessionId);

			// Exactly ONE host-agents reviewer is owned by the parent.
			const reviewers = gateway.orchestrationCore.list(owner).filter((h: any) => h.childKind === "host-agents");
			expect(reviewers).toHaveLength(1);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Concurrency dedupe — two OVERLAPPING runs → one reviewer (FINDING 3). ──
	// Pins the ACHIEVABLE concurrency invariant. Each host.callRoute("run") runs in a
	// FRESH worker, so the module-scoped in-flight map only dedups invokes that share
	// a worker; across workers the `run` route's post-claim RECONCILE
	// (launchReviewer) dismisses the losing child and converges to one live reviewer.
	// Strict cross-worker atomicity would need a store CAS the pack store does not
	// expose (design Decision E). So this pins the ROBUST, NON-FLAKY invariant: two
	// near-simultaneous `run` calls for the SAME owner+target fired via Promise.all
	// both succeed, both return a usable childSessionId, and the reviewer index
	// resolves to a SINGLE childSessionId naming one of the two (no split-brain
	// jobId / no crash). Strict "exactly one LIVE child" is NOT asserted: in the
	// pathological lock-step interleaving each worker re-reads its own claim before
	// the other's write lands, so the post-claim reconcile cannot always dismiss the
	// loser — the residual orphan is reaped on parent archive (cascade reap). The
	// panel's busy-guard prevents the common double-click, so this edge case is
	// defence-in-depth, not the normal path.
	test("two overlapping run calls for the same target keep a single reviewer index (best-effort dedup)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			const [a, b] = await Promise.all([
				invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd),
				invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd),
			]);
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			expect(typeof a.childSessionId).toBe("string");
			expect(typeof b.childSessionId).toBe("string");
			createdSessionIds.push(a.childSessionId, b.childSessionId);

			// No split-brain: both runs share the canonical key, so exactly ONE
			// reviewer/<parent>/<key> entry exists and it names one of the two children.
			const reviewerKeys = await getPackStore().list(PACK_ID, `reviewer/${owner}/`);
			expect(reviewerKeys).toHaveLength(1);
			const idx = await getPackStore().get<{ childSessionId?: string }>(PACK_ID, reviewerKeys[0]);
			expect(idx?.childSessionId).toBeTruthy();
			expect([a.childSessionId, b.childSessionId]).toContain(idx!.childSessionId);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Status route is binding-authoritative (right-job routing). ──
	test("status rejects a mismatched jobId or a foreign childSessionId without leaking a submitted marker", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);

			// Mismatched jobId → structured error, never reads the real submitted marker.
			const mismatch = await invokeRoute(gateway, owner, "status", {
				method: "POST",
				body: { childSessionId: child, jobId: "prw-some-other-job" },
			}, fixture.cwd);
			expect(mismatch.phase).toBe("error");
			expect(mismatch.yaml).toBeUndefined();

			// A childSessionId the caller does not own (the owner itself) → error.
			const foreign = await invokeRoute(gateway, owner, "status", {
				method: "POST",
				body: { childSessionId: owner, jobId: started.jobId },
			}, fixture.cwd);
			expect(foreign.phase).toBe("error");

			// Running (not yet submitted) → phase running for the correct binding.
			const running = await invokeRoute(gateway, owner, "status", {
				method: "POST",
				body: { childSessionId: child, jobId: started.jobId },
			}, fixture.cwd);
			expect(["running", "submitted"]).toContain(running.phase);

			// After a real submit, the correct binding reports submitted with the YAML.
			const submitResp = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, child) },
				body: JSON.stringify({ yaml }),
			});
			expect(submitResp.status).toBe(200);

			const submitted = await invokeRoute(gateway, owner, "status", {
				method: "POST",
				body: { childSessionId: child, jobId: started.jobId },
			}, fixture.cwd);
			expect(submitted.phase).toBe("submitted");
			expect(submitted.yaml).toBe(yaml);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Cleanup — submit server-dismisses the reviewer (terminal-synchronous). ──
	test("submit-yaml server-dismisses the reviewer child (terminal-synchronous reap)", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		const yaml = buildValidYaml(fixture.baseSha, fixture.headSha);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);
			// Reviewer is live before submit.
			expect(gateway.orchestrationCore.list(owner).some((h: any) => h.sessionId === child)).toBe(true);

			const submitResp = await apiFetch("/api/internal/pr-walkthrough/submit-yaml", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": reviewerSecret(gateway, child) },
				body: JSON.stringify({ yaml }),
			});
			expect(submitResp.status).toBe(200);

			// The reviewer is dismissed without waiting for a panel poll, and the
			// generic terminal marker is stamped (so a pre-poll restart still reaps it).
			await pollUntil(() => {
				const live = gateway.orchestrationCore.list(owner).some((h: any) => h.sessionId === child);
				return live ? null : true;
			}, { timeoutMs: 10_000, intervalMs: 50, label: "reviewer dismissed on submit" });
			const persisted = gateway.sessionManager.getPersistedSession(child)
				?? gateway.sessionManager.getArchivedSession?.(child);
			expect(persisted?.childTerminal).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: No orphan reviewer after restart (generic childTerminal boot-reap). ──
	test("a childTerminal host-agents reviewer is boot-reaped even while its parent is alive", async ({ gateway }) => {
		const sm = gateway.sessionManager;
		const owner = await createSession();
		createdSessionIds.push(owner);
		const parentProjectId = sm.getPersistedSession(owner)?.projectId;
		const childInfo = await sm.createSession(
			sm.getSession(owner)?.cwd,
			undefined, undefined, undefined,
			{ parentSessionId: owner, childKind: "host-agents", readOnly: true, projectId: parentProjectId },
		);
		const child = childInfo.id;
		try {
			// Stamp the GENERIC persisted terminal marker (what submit-yaml does before
			// it dismisses). The parent stays ALIVE — only the marker drives the reap.
			sm.updateSessionMeta(child, { childTerminal: true, terminalAt: Date.now() });
			expect(sm.getPersistedSession(child)?.childTerminal).toBe(true);

			// Drive the per-session boot path; the generic kindTerminal reap archives
			// the orphan before any re-spawn.
			await (sm as any).restoreOneSession(sm.getPersistedSession(child));

			const stillLive = gateway.projectContextManager.getAllLiveSessions().some((s: any) => s.id === child);
			expect(stillLive).toBe(false);
		} finally {
			await deleteSession(child).catch(() => {});
		}
	});

	// ── Row A2 + A3: the spawned reviewer's GUARD does not block the three tools,
	//    and its prompt carries the YAML schema (role-resolution bug fix). ──
	// The reported regression was that the reviewer child held the three tools in
	// its allowlist (spawn-path resolveRoleAllowedTools was already cascade-aware)
	// but every CALL was hard-blocked by the generated tool GUARD — because
	// session-setup resolved the pack-shipped `pr-reviewer` role via roleManager
	// only (→ undefined → `PR Walkthrough: never` group default → all three tools
	// in the guard's neverPolicies). A one-tool check would not pin the class: the
	// bug blocked readonly_bash / submit even when bundle worked. So we assert the
	// guard blocks NONE of the three, AND that the schema reached the prompt.
	test("the spawned reviewer's guard blocks none of the three tools and its prompt carries the YAML schema", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);

			// A2: read the ACTUAL guard(s) the gateway generated for this child.
			const { neverNames, guardFiles } = childGuardNeverNames(gateway, child);
			// A guard WAS generated (the reviewer denies every non-walkthrough tool,
			// so the guard exists and is real) — and proves the default-deny still
			// bites the tools the reviewer must NOT have.
			expect(guardFiles, "a tool-guard extension must be generated for the reviewer").toBeGreaterThan(0);
			expect(neverNames.has("write"), "the read-only reviewer's guard must still hard-block `write`").toBe(true);
			// The three walkthrough tools must NOT be hard-blocked (the bug).
			for (const t of REVIEWER_TOOLS) {
				expect(neverNames.has(t), `guard must NOT hard-block ${t} ("not permitted for this role")`).toBe(false);
			}

			// A3: the reviewer's system prompt carries the submit_pr_walkthrough_yaml
			// schema (so it does not have to "learn the schema from validation
			// feedback"). The spawn path threads only `roleName`, so the pack role's
			// promptTemplate is resolved cascade-first in createSession.
			const parts = gateway.sessionManager.getPromptParts(child);
			const rolePrompt = String(parts?.rolePrompt ?? "");
			expect(rolePrompt).toContain("schema_version");
			expect(rolePrompt).toContain("merge_assessment");
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row A4: a reviewer surviving a gateway restart keeps its tools. ──
	// The restore / force-respawn paths resolve the session role via
	// `resolveSessionRole`, which the fix makes cascade-aware + projectId-scoped.
	// Without the projectId the pack role is lost (roleManager has no `pr-reviewer`)
	// and the regenerated guard re-blocks the three tools. This pins the restore
	// path's resolution against the gateway's REAL group-policy store.
	test("a restored reviewer re-resolves the pack role (cascade + projectId) and keeps its three tools", async ({ gateway }) => {
		const { resolveGrantPolicy } = await import("../../dist/server/agent/tool-activation.js");
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);

			const ps = gateway.sessionManager.getPersistedSession(child);
			const sm: any = gateway.sessionManager;
			const groupPolicyStore = sm.groupPolicyStore;

			// The restore path now calls resolveSessionRole(ps.role, ps.assistantType, ps.projectId).
			const restoredRole = sm.resolveSessionRole(ps?.role, ps?.assistantType, ps?.projectId);
			expect(restoredRole?.name).toBe("pr-reviewer");
			expect(restoredRole?.toolPolicies?.["PR Walkthrough"]).toBe("allow");

			// The PRE-FIX call shape (no projectId) loses the pack role entirely —
			// roleManager has no `pr-reviewer`, so the guard would re-block the trio.
			const preFixRole = sm.resolveSessionRole(ps?.role, ps?.assistantType, undefined);
			expect(preFixRole).toBeUndefined();

			// The restore prompt path resolves the role's promptTemplate via
			// resolveRolePromptTemplate, which is now pack-aware — so a restored reviewer
			// keeps its YAML schema too (not just its tools).
			const restoredTemplate = String(sm.resolveRolePromptTemplate(ps?.role, ps?.projectId) ?? "");
			expect(restoredTemplate).toContain("schema_version");
			expect(restoredTemplate).toContain("merge_assessment");

			// The restored allowlist (persisted) still carries the three tools, and the
			// regenerated guard (driven by resolveGrantPolicy over the restored role)
			// grants them — while the pre-fix undefined role would resolve them to never.
			for (const t of REVIEWER_TOOLS) {
				expect((ps?.allowedTools ?? []).includes(t), `restored allowlist must keep ${t}`).toBe(true);
				expect(resolveGrantPolicy(t, "PR Walkthrough", restoredRole, undefined, groupPolicyStore)).toBe("allow");
				expect(resolveGrantPolicy(t, "PR Walkthrough", preFixRole, undefined, groupPolicyStore)).toBe("never");
			}
		} finally {
			fixture.cleanup();
		}
	});

	// ── Row: Scope — the pack drives only its own reviewer child. ──
	test("the run/status routes see only the reviewer they spawned, not sibling delegate children", async ({ gateway }) => {
		const fixture = makeGitFixture();
		const owner = await createSession({ cwd: fixture.cwd });
		createdSessionIds.push(owner);
		let delegateChild: string | undefined;
		try {
			const started = await invokeRoute(gateway, owner, "run", runReq(fixture), fixture.cwd);
			const child = started.childSessionId;
			createdSessionIds.push(child);

			// A sibling DELEGATE child of the SAME owner (the agent-tool path).
			const del = await gateway.orchestrationCore.spawn({
				ownerSessionId: owner,
				instructions: "delegate child",
				childKind: "delegate",
			});
			delegateChild = del.sessionId;

			// host.agents sees ONLY the host-agents reviewer.
			const host = buildHost(gateway, owner);
			const listed = await host.agents.list();
			expect(listed.map((c: any) => c.childSessionId)).toEqual([child]);

			// status against the sibling delegate child → binding-authoritative error
			// (the delegate has no pr-walkthrough binding and is not a host-agents child).
			const st = await invokeRoute(gateway, owner, "status", {
				method: "POST",
				body: { childSessionId: delegateChild, jobId: started.jobId },
			}, fixture.cwd);
			expect(st.phase).toBe("error");
		} finally {
			if (delegateChild) await gateway.orchestrationCore.dismiss(owner, delegateChild).catch(() => {});
			fixture.cleanup();
		}
	});
});
