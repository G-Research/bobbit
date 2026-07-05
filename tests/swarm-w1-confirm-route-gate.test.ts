/**
 * SWARM-W1 — pins the human-token gate stack around
 * `forceIntegrateSwarmWinner`, not just the flag mechanics
 * (`swarm-w1-merge-winner.test.ts` already pins those in isolation).
 *
 * The invariant: `GoalManager.mergeChild`'s `forceIntegrateSwarmWinner: true`
 * escape hatch (goal-manager.ts ~L819) may be set ONLY by
 * `POST /api/goals/:id/swarm-groups/:swarmGroup/confirm` (swarm-routes.ts
 * ~L220), and ONLY after:
 *   1. the caller passes `authorizeChildrenMutation`'s "operator" class
 *      (children-mutation-authz.ts) — a verified human/UI cookie OR an
 *      authentic team-lead session;
 *   2. the caller is SPECIFICALLY human (`auth.humanConfirmed` — a
 *      cookie-authenticated agent-authenticated-as-team-lead is NOT enough:
 *      an agent must never be able to confirm its own pick);
 *   3. a one-shot, binding-hashed operator-confirmation token
 *      (auth/operator-confirmation.ts) minted for this EXACT
 *      `{swarmGroup, winnerGoalId}` pair is presented and consumed.
 *
 * This file drives `tryHandleSwarmRoute` directly (same in-memory-stub
 * pattern as tests/nested-goal-routes-findings.test.ts) with REAL,
 * unmodified production modules — GoalStore/GoalManager,
 * SwarmGroupStore, CookieStore, SessionSecretStore,
 * children-mutation-authz.ts (imported transitively by swarm-routes.ts),
 * and operator-confirmation.ts (imported transitively AND directly, for the
 * primitive-level block below). The ONLY thing stubbed is
 * `GoalManager.mergeChild` itself (a spy recording the exact `opts` it
 * receives) — this avoids needing a real two-repo git fixture (that
 * end-to-end real-merge proof already lives in
 * tests/e2e/api-swarm-best-of-n.spec.ts) while still proving, for every
 * rejected path, that the goal-manager NEVER receives
 * `forceIntegrateSwarmWinner: true`, and for the happy path, that it
 * receives EXACTLY one call with EXACTLY that value.
 *
 * Confirmation tokens are minted via a REAL `/verify` call (never a direct
 * import of the internal purpose string swarm-routes.ts uses) so the
 * "wrong binding" / "happy path" tests exercise the actual mint path, not a
 * hand-rolled stand-in for it.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { tryHandleSwarmRoute, type SwarmRouteDeps } from "../src/server/agent/swarm-routes.ts";
import { CookieStore } from "../src/server/auth/cookie.ts";
import { SessionSecretStore } from "../src/server/auth/session-secret.ts";
import {
	mintOperatorConfirmation,
	consumeOperatorConfirmation,
	stableConfirmationBinding,
	__resetOperatorConfirmationsForTests,
} from "../src/server/auth/operator-confirmation.ts";

interface MergeCall {
	parentGoalId: string;
	childGoalId: string;
	opts: { forceIntegrateSwarmWinner?: boolean } | undefined;
}

interface Harness {
	tmpRoot: string;
	goalStore: GoalStore;
	goalManager: GoalManager;
	parentId: string;
	winnerAId: string;
	winnerBId: string;
	swarmGroupA: string;
	swarmGroupB: string;
	mergeCalls: MergeCall[];
	humanCookieHeader: string;
	teamLeadByGoal: Record<string, string | undefined>;
	authAsTeamLead(sessionId: string): Record<string, string>;
	cleanup(): void;
	call(
		method: string,
		pathname: string,
		body?: unknown,
		headers?: Record<string, string | string[] | undefined>,
	): Promise<{ status: number; payload: any }>;
}

async function makeHarness(): Promise<Harness> {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-confirm-gate-"));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	const goalStore = new GoalStore(stateDir);
	const cookieStore = new CookieStore(stateDir);
	const humanCookieHeader = `bobbit_session=${cookieStore.mint()}`;
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	const goalManager = new GoalManager(goalStore, wf);

	const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
	const swarmGroupA = "grp-a";
	const swarmGroupB = "grp-b";
	const winnerA = await goalManager.createGoal("Winner A", tmpRoot, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: swarmGroupA });
	const winnerB = await goalManager.createGoal("Winner B", tmpRoot, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: swarmGroupB });
	// Real, existing cwd for the deterministic-verifier shell command to run
	// in (the winning candidate's worktree in production) — `tmpRoot` stands
	// in fine since we never exercise a real git merge here (mergeChild is
	// spied, see below).
	goalStore.update(winnerA.id, { worktreePath: tmpRoot });
	goalStore.update(winnerB.id, { worktreePath: tmpRoot });

	const swarmGroupStore = new SwarmGroupStore(stateDir);
	swarmGroupStore.createGroup(swarmGroupA, [winnerA.id], parent.id, { parentGoalId: parent.id, verifyCommand: "true" });
	swarmGroupStore.createGroup(swarmGroupB, [winnerB.id], parent.id, { parentGoalId: parent.id, verifyCommand: "true" });
	// Barrier-fire both groups with a single "done" candidate each so /verify
	// has something deterministic to pick.
	swarmGroupStore.recordArtifact(swarmGroupA, { goalId: winnerA.id, output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, [winnerA.id], parent.id);
	swarmGroupStore.recordArtifact(swarmGroupB, { goalId: winnerB.id, output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, [winnerB.id], parent.id);

	const mergeCalls: MergeCall[] = [];
	// The ONE thing stubbed: mergeChild itself, as a recording spy — no real
	// git fixture needed to prove exactly what `opts` the route passes.
	(goalManager as any).mergeChild = async (parentGoalId: string, childGoalId: string, opts?: { forceIntegrateSwarmWinner?: boolean }) => {
		mergeCalls.push({ parentGoalId, childGoalId, opts });
		return { merged: true, alreadyMerged: false, conflict: false, pushed: false };
	};

	const ctx = { goalStore, swarmGroupStore };
	const projectContextManager: any = { getContextForGoal: () => ctx };
	const teamLeadByGoal: Record<string, string | undefined> = {};
	const teamManager: any = {
		getTeamState: (gid: string) => (gid in teamLeadByGoal ? { teamLeadSessionId: teamLeadByGoal[gid] } : undefined),
		teardownTeam: async () => {},
	};
	const sessionSecretStore = new SessionSecretStore();
	const sessionManager: any = { sessionSecretStore };
	const verificationHarness: any = {};

	const baseDeps: SwarmRouteDeps = {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		cookieStore,
		getGoalAcrossProjects: (gid: string) => goalStore.get(gid),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {},
		jsonError: () => {},
		broadcastToAll: () => {},
	};

	async function call(
		method: string,
		pathname: string,
		body?: unknown,
		headers: Record<string, string | string[] | undefined> = {},
	): Promise<{ status: number; payload: any }> {
		let status = 200;
		let payload: any = undefined;
		const localDeps: SwarmRouteDeps = {
			...baseDeps,
			json: (b, s) => { status = s ?? 200; payload = b; },
			jsonError: (s, err, extra) => { status = s; payload = { error: String((err as any)?.message ?? err), ...(extra ?? {}) }; },
		};
		const req = { method, headers, _body: body } as any as http.IncomingMessage;
		const url = new URL(`http://x${pathname}`);
		const handled = await tryHandleSwarmRoute(req, url, localDeps);
		if (!handled) throw new Error(`route not handled: ${method} ${pathname}`);
		return { status, payload };
	}

	return {
		tmpRoot, goalStore, goalManager,
		parentId: parent.id, winnerAId: winnerA.id, winnerBId: winnerB.id,
		swarmGroupA, swarmGroupB, mergeCalls, humanCookieHeader, teamLeadByGoal,
		authAsTeamLead(sessionId: string) {
			return { "x-bobbit-session-secret": sessionSecretStore.getOrCreateSecret(sessionId) };
		},
		cleanup() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ } },
		call,
	};
}

let h: Harness;
beforeEach(async () => {
	__resetOperatorConfirmationsForTests();
	h = await makeHarness();
});
afterEach(() => h.cleanup());

/** Drive the REAL /verify route (human-cookie'd) to mint a genuine, correctly-bound confirmation token for `swarmGroup`'s winner. */
async function mintRealToken(h: Harness, swarmGroup: string, winnerGoalId: string): Promise<string> {
	const resp = await h.call("POST", `/api/goals/${h.parentId}/swarm-groups/${swarmGroup}/verify`, undefined, { cookie: h.humanCookieHeader });
	assert.equal(resp.status, 200, `verify must succeed to mint a token (got ${JSON.stringify(resp.payload)})`);
	assert.equal(resp.payload.outcome, "picked");
	assert.equal(resp.payload.winnerGoalId, winnerGoalId);
	assert.ok(resp.payload.confirmationToken, "human verify must mint a confirmation token");
	return resp.payload.confirmationToken;
}

describe("SWARM-W1 confirm route — human-token gate stack", () => {
	it("no auth at all (no cookie, no authentic session) is rejected and never reaches the goal-manager", async () => {
		const r = await h.call("POST", `/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`, { winnerGoalId: h.winnerAId, confirmationToken: "whatever" });
		assert.equal(Math.floor(r.status / 100), 4);
		assert.equal(h.mergeCalls.length, 0);
	});

	it("an authenticated TEAM-LEAD AGENT (no human cookie) cannot self-confirm — 403, never reaches the goal-manager", async () => {
		const TL = "team-lead-session";
		h.teamLeadByGoal[h.parentId] = TL;
		// Mint a real, correctly-bound token as a human first (simulating that
		// a human DID run /verify) — the agent then tries to redeem it itself,
		// without ever carrying the human cookie.
		const token = await mintRealToken(h, h.swarmGroupA, h.winnerAId);
		const r = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: token },
			h.authAsTeamLead(TL),
		);
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "HUMAN_CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 0, "an agent holding a valid token but no human cookie must never reach mergeChild");
	});

	it("human cookie present but NO confirmation token → 403, never reaches the goal-manager", async () => {
		const r = await h.call("POST", `/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`, { winnerGoalId: h.winnerAId }, { cookie: h.humanCookieHeader });
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 0);
	});

	it("human cookie + a garbage/never-minted confirmation token → 403, never reaches the goal-manager", async () => {
		const r = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: "not-a-real-token-at-all" },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(r.status, 403);
		assert.equal(r.payload.code, "CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 0);
	});

	it("a token minted for a DIFFERENT pick (wrong binding) is rejected — and the binding check burns the token one-shot even on mismatch", async () => {
		// Mint a real token bound to group B's winner.
		const tokenForB = await mintRealToken(h, h.swarmGroupB, h.winnerBId);

		// Attempt to redeem it against group A's (different swarmGroup, different winnerGoalId) pick.
		const wrongGroup = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: tokenForB },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(wrongGroup.status, 403);
		assert.equal(wrongGroup.payload.code, "CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 0, "a binding mismatch must never reach mergeChild");

		// The token is now burned — even redeeming it against its OWN correct
		// (group, winner) pair must now fail (one-shot: consumption happens
		// on lookup, before the binding comparison).
		const correctGroupNowBurned = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupB}/confirm`,
			{ winnerGoalId: h.winnerBId, confirmationToken: tokenForB },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(correctGroupNowBurned.status, 403);
		assert.equal(correctGroupNowBurned.payload.code, "CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 0);
	});

	it("happy path: human cookie + a correctly-minted token → 200 integrated, and mergeChild is called EXACTLY ONCE with forceIntegrateSwarmWinner:true for the right pair", async () => {
		const token = await mintRealToken(h, h.swarmGroupA, h.winnerAId);
		const r = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: token },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(r.status, 200);
		assert.equal(r.payload.integrated, true);
		assert.equal(r.payload.winnerGoalId, h.winnerAId);
		assert.equal(h.mergeCalls.length, 1);
		assert.deepEqual(h.mergeCalls[0], { parentGoalId: h.parentId, childGoalId: h.winnerAId, opts: { forceIntegrateSwarmWinner: true } });
	});

	it("reusing the SAME token after a successful confirm is rejected and does NOT trigger a second mergeChild call", async () => {
		const token = await mintRealToken(h, h.swarmGroupA, h.winnerAId);
		const first = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: token },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(first.status, 200);
		assert.equal(h.mergeCalls.length, 1);

		const second = await h.call(
			"POST",
			`/api/goals/${h.parentId}/swarm-groups/${h.swarmGroupA}/confirm`,
			{ winnerGoalId: h.winnerAId, confirmationToken: token },
			{ cookie: h.humanCookieHeader },
		);
		assert.equal(Math.floor(second.status / 100), 4, "reuse must be rejected (4xx), whether via ALREADY_INTEGRATED or CONFIRMATION_REQUIRED");
		assert.equal(h.mergeCalls.length, 1, "reuse must never cause a second merge — no double-integration");
	});
});

/**
 * The route-level tests above prove reuse can't cause a SECOND merge (the
 * security-relevant outcome). This block pins the underlying PRIMITIVE
 * directly — the real, unmodified `operator-confirmation.ts` module the
 * route imports — to prove the one-shot/binding/TTL mechanics hold
 * independent of the confirm route's own "already integrated" idempotency
 * guard (which, on this route, happens to also block a same-group replay
 * before the token is even re-checked).
 */
describe("operator-confirmation primitive — one-shot + binding + TTL (what the route depends on)", () => {
	it("a token can be consumed exactly once — the second consumption of the SAME token returns false", () => {
		const binding = stableConfirmationBinding({ swarmGroup: "g", winnerGoalId: "w" });
		const { token } = mintOperatorConfirmation({ purpose: "test-purpose", binding });
		assert.equal(consumeOperatorConfirmation(token, { purpose: "test-purpose", binding }), true);
		assert.equal(consumeOperatorConfirmation(token, { purpose: "test-purpose", binding }), false, "one-shot: token must not be redeemable twice");
	});

	it("a token minted for one binding is rejected against a different binding, and is burned by the attempt", () => {
		const bindingA = stableConfirmationBinding({ swarmGroup: "g", winnerGoalId: "winner-a" });
		const bindingB = stableConfirmationBinding({ swarmGroup: "g", winnerGoalId: "winner-b" });
		const { token } = mintOperatorConfirmation({ purpose: "test-purpose", binding: bindingA });
		assert.equal(consumeOperatorConfirmation(token, { purpose: "test-purpose", binding: bindingB }), false);
		// Burned even though the mismatched attempt failed — a fresh attempt
		// with the CORRECT binding must also now fail.
		assert.equal(consumeOperatorConfirmation(token, { purpose: "test-purpose", binding: bindingA }), false);
	});

	it("an expired token is rejected even with the correct purpose+binding", () => {
		const binding = stableConfirmationBinding({ swarmGroup: "g", winnerGoalId: "w" });
		let now = 1_000_000;
		const { token, expiresAt } = mintOperatorConfirmation({ purpose: "test-purpose", binding }, { ttlMs: 1000, now: () => now });
		assert.equal(expiresAt, now + 1000);
		now += 1001; // one ms past expiry
		assert.equal(consumeOperatorConfirmation(token, { purpose: "test-purpose", binding }, { now: () => now }), false);
	});
});

describe("source pin — forceIntegrateSwarmWinner:true has exactly ONE call site", () => {
	it("the literal `forceIntegrateSwarmWinner: true` appears exactly once in src/, in swarm-routes.ts's confirm handler, passed to goalManager.mergeChild", () => {
		const repoRoot = path.resolve(import.meta.dirname, "..");
		const srcRoot = path.join(repoRoot, "src");
		const hits: Array<{ file: string; line: number; text: string }> = [];
		const pattern = /forceIntegrateSwarmWinner\s*:\s*true/;

		function walk(dir: string): void {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === "dist") continue;
					walk(full);
				} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
					const lines = fs.readFileSync(full, "utf8").split("\n");
					lines.forEach((text, i) => {
						if (pattern.test(text)) hits.push({ file: path.relative(repoRoot, full), line: i + 1, text: text.trim() });
					});
				}
			}
		}
		walk(srcRoot);

		assert.equal(hits.length, 1, `expected exactly one \`forceIntegrateSwarmWinner: true\` call site in src/, found ${hits.length}:\n${hits.map(h => `  ${h.file}:${h.line}: ${h.text}`).join("\n")}\nIf you just added a legitimate new one, the human-token gate must guard it too — update this test's expected count only alongside an equivalent gate.`);
		assert.equal(hits[0].file, "src/server/agent/swarm-routes.ts", "the sole call site must be the human-gated confirm route");
		assert.match(hits[0].text, /goalManager\.mergeChild\(/, "the flag must be passed directly into the mergeChild(...) call, not staged/reassigned elsewhere");
	});
});
