/**
 * S3 (extension-seam audit, P1) — pin for the swarm turn-budget governor
 * hot path BEFORE extracting the narrow `TurnBudgetGovernor` seam.
 *
 * `SessionManager.trackCostFromEvent`'s `message_end` hook is the ONE place
 * cumulative turn usage becomes known (see swarm-governor.ts's module doc /
 * SWARM-W1). Until this pin, nothing exercised that hot-path integration at
 * the `SessionManager` level — `tests/swarm-w1-governor.test.ts` covers
 * `SwarmGovernor`'s pure logic directly, and no test wired a harness into a
 * real `SessionManager` and drove `message_end` events through it. This
 * file pins, at the `trackCostFromEvent` call site:
 *   - unregistered goal → zero-cost no-op fast path (no abort, no hard-kill),
 *     even for an enormous token spend.
 *   - registered node crossing `tokenBudget` → `abort-turn`, observed as
 *     `session.rpcClient.abort()`.
 *   - registered node crossing `tokenBudget * hardKillMarginMultiplier` →
 *     `hard-kill`, observed via the harness's hard-kill executor
 *     (`hardKillSwarmNode`, monkey-patched here to isolate the pin from
 *     `notifyChildTerminal`'s own unrelated complexity).
 *
 * Written to survive the S3 seam extraction unmodified: it drives the same
 * public entry point (`trackCostFromEvent`) and observes the same two
 * externally-visible effects (`rpcClient.abort()`, `hardKillSwarmNode`)
 * regardless of whether the hot path internally reaches
 * `_verificationHarness.swarmGovernor.checkTokenBudget` directly (pre-seam)
 * or through the narrow `_verificationHarness.turnBudgetGovernor.check`/
 * `.hardKill` seam (post-seam) — `hardKillSwarmNode` is looked up on `this`
 * at call time either way, so monkey-patching the instance method is picked
 * up by both call shapes.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");
const { ProjectContextManager } = await import("../src/server/agent/project-context-manager.ts");
const { ProjectRegistry } = await import("../src/server/agent/project-registry.ts");

function makeMessageEndEvent(inputTokens: number, outputTokens: number, cost = 0.001) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			usage: { inputTokens, outputTokens, cost },
		},
	};
}

describe("SessionManager.trackCostFromEvent — swarm turn-budget governor hot path (S3 pin)", () => {
	const tmpRoots: string[] = [];

	after(() => {
		for (const root of tmpRoots) {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
		}
	});

	function setup() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-budget-governor-"));
		tmpRoots.push(root);
		const registryStateDir = path.join(root, "state");
		const projectRoot = path.join(root, "project");
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.mkdirSync(registryStateDir, { recursive: true });

		const projectId = "proj-1";
		fs.writeFileSync(path.join(registryStateDir, "projects.json"), JSON.stringify([{
			id: projectId,
			name: "Project 1",
			rootPath: projectRoot,
			createdAt: Date.now(),
			colorLight: "#3b82f6",
			colorDark: "#60a5fa",
		}]));

		const registry = new ProjectRegistry(registryStateDir);
		const pcm = new ProjectContextManager(registry);
		const sessionManager = new SessionManager({ projectContextManager: pcm }) as any;
		// Minimal-but-real VerificationHarness: RoleStore stubbed (unused by the
		// governor path), no gateStore/preferencesStore/sessionManager/teamManager/
		// projectConfigStore/projectContextManager/configCascade needed — the
		// governor path only touches `swarmGovernor` and `hardKillSwarmNode`
		// (the latter monkey-patched per-test below to isolate the pin from
		// `notifyChildTerminal`'s own complexity, per this file's header note).
		const harness = new VerificationHarness(
			path.join(root, "harness-state"),
			undefined,
			() => {},
			{ get: () => null, getAll: () => [] } as any,
		) as any;
		sessionManager.setVerificationHarness(harness);
		return { root, projectId, sessionManager, harness };
	}

	function makeSession(id: string, projectId: string, goalId: string) {
		const abortCalls: number[] = [];
		const session: any = {
			id,
			projectId,
			goalId,
			teamGoalId: undefined,
			taskId: undefined,
			clients: new Set(),
			rpcClient: { abort: async () => { abortCalls.push(1); } },
		};
		return { session, abortCalls };
	}

	it("unregistered goal: zero-cost no-op fast path — no abort, no hard-kill, even far over any plausible ceiling", () => {
		const { sessionManager, projectId } = setup();
		const { session, abortCalls } = makeSession("s-unreg", projectId, "goal-unregistered");
		let hardKillCalls = 0;
		sessionManager._verificationHarness.hardKillSwarmNode = async () => { hardKillCalls++; };

		// This goal was never `registerNode`-d — `checkTokenBudget` must be a
		// pure Map-miss returning `{kind:"ok"}` regardless of spend.
		sessionManager.trackCostFromEvent(session, makeMessageEndEvent(10_000_000, 10_000_000));

		assert.equal(abortCalls.length, 0, "must not abort an ungoverned goal's turn");
		assert.equal(hardKillCalls, 0, "must not hard-kill an ungoverned goal");
	});

	it("registered node crossing tokenBudget: abort-turn observed as session.rpcClient.abort()", () => {
		const { sessionManager, harness, projectId } = setup();
		const { session, abortCalls } = makeSession("s-abort", projectId, "goal-abort");
		let hardKillCalls = 0;
		harness.hardKillSwarmNode = async () => { hardKillCalls++; };
		harness.swarmGovernor.registerNode("goal-abort", { tokenBudget: 100, wallClockMs: 0 }, () => {});

		// Below budget (60 total): no-op.
		sessionManager.trackCostFromEvent(session, makeMessageEndEvent(30, 30));
		assert.equal(abortCalls.length, 0, "below tokenBudget must not abort");

		// Crosses tokenBudget (120 total >= 100): abort-turn.
		sessionManager.trackCostFromEvent(session, makeMessageEndEvent(30, 30));
		assert.equal(abortCalls.length, 1, "must abort the in-flight turn once cumulative spend crosses tokenBudget");
		assert.equal(hardKillCalls, 0, "abort-turn alone must not also hard-kill");
	});

	it("registered node crossing the hard-kill margin: hard-kill executed via the harness's executor", async () => {
		const { sessionManager, harness, projectId } = setup();
		const { session } = makeSession("s-hardkill", projectId, "goal-hardkill");
		const hardKillCalls: Array<{ goalId: string; reason: string }> = [];
		harness.hardKillSwarmNode = async (goalId: string, reason: string) => { hardKillCalls.push({ goalId, reason }); };
		harness.swarmGovernor.registerNode("goal-hardkill", { tokenBudget: 100, hardKillMarginMultiplier: 1.5, wallClockMs: 0 }, () => {});

		// 150 total >= 150 hard-kill ceiling (100 * 1.5).
		sessionManager.trackCostFromEvent(session, makeMessageEndEvent(80, 70));
		// The hard-kill executor is fired-and-`.catch()`'d, not awaited on the
		// hot path (see session-manager.ts's `trackCostFromEvent` doc) — flush
		// microtasks before asserting.
		await new Promise((r) => setTimeout(r, 0));

		assert.equal(hardKillCalls.length, 1, "must hard-kill once cumulative spend crosses the hard-kill margin");
		assert.equal(hardKillCalls[0].goalId, "goal-hardkill");
	});
});
