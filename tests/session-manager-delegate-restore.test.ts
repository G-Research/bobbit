/**
 * Unit tests for delegate restart survival (Delegate Restart Survival goal).
 *
 * Two concerns are pinned here:
 *
 *  1. FUNCTIONAL — restoreSession()'s delegate branch rebuilds the system prompt
 *     from the durable `instructions` (+ `context`) fields, exactly mirroring
 *     session-setup.ts::_resolvePrompt mode === "delegate". We exercise the real
 *     prompt assembler (`assembleSystemPrompt`) with the same taskSpec-building
 *     logic and assert the assembled prompt carries the original instructions +
 *     context — NOT the empty goal/role branch a delegate (no goalId) would
 *     otherwise hit.
 *
 *  2. SOURCE GUARD — restoreSession() must take a delegate branch (delegateOf set,
 *     no goalId) BEFORE the goal/role else branch, and restoreSessions() must
 *     restore surviving delegates LIVE (restoreOneSession), not as dormant husks
 *     (addDormantSession). If a future refactor drops either, these fail loudly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-restore-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { assembleSystemPrompt, initPromptDirs } = await import("../src/server/agent/system-prompt.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

// assembleSystemPrompt writes to <stateDir>/session-prompts — initialize it.
initPromptDirs(path.join(tmpRoot, "state"));

/**
 * Verbatim copy of restoreSession()'s delegate-branch taskSpec assembly
 * (and session-setup.ts::_resolvePrompt mode === "delegate"). Kept in lock-step
 * with the production branch by the source guard below.
 */
function buildDelegateTaskSpec(ps: Pick<PersistedSession, "instructions" | "context">): string {
	let taskSpec = ps.instructions || "";
	if (ps.context && Object.keys(ps.context).length > 0) {
		taskSpec += "\n\n## Context";
		for (const [key, value] of Object.entries(ps.context)) {
			taskSpec += `\n- **${key}**: ${value}`;
		}
	}
	return taskSpec;
}

describe("delegate restore — prompt re-assembly from durable task", () => {
	it("rebuilds the system prompt from persisted instructions + context", () => {
		const ps: PersistedSession = {
			id: "delegate-1",
			title: "⚡Delegate",
			cwd: tmpRoot,
			agentSessionFile: path.join(tmpRoot, "agent.jsonl"),
			createdAt: Date.now(),
			lastActivity: Date.now(),
			delegateOf: "owner-1",
			instructions: "restart-live-survivor-MARKER helper task",
			context: { role: "helper", deadline: "eod" },
		};

		const taskSpec = buildDelegateTaskSpec(ps);
		const promptPath = assembleSystemPrompt(ps.id, {
			cwd: ps.cwd,
			goalSpec: taskSpec,
			goalTitle: "Delegate Task",
			goalState: "active",
		});

		assert.ok(promptPath, "delegate restore must produce a system prompt path");
		const prompt = fs.readFileSync(promptPath!, "utf-8");
		// Task intact — the original instructions land in the rebuilt prompt.
		assert.match(prompt, /restart-live-survivor-MARKER helper task/);
		// Context is layered in too.
		assert.match(prompt, /## Context/);
		assert.match(prompt, /\*\*role\*\*: helper/);
		assert.match(prompt, /\*\*deadline\*\*: eod/);
	});

	it("produces an EMPTY (no-goal) prompt when the delegate task is NOT rebuilt", () => {
		// Demonstrates the bug the delegate branch fixes: a delegate has no goal,
		// so the goal/role branch yields no goal spec — the task evaporates.
		const promptPath = assembleSystemPrompt("delegate-empty", {
			cwd: tmpRoot,
			goalSpec: undefined, // what the goal/role branch sees for a delegate (no goal)
		});
		const prompt = promptPath ? fs.readFileSync(promptPath, "utf-8") : "";
		assert.ok(!/restart-live-survivor-MARKER/.test(prompt), "without the delegate branch the task is lost");
	});
});

describe("delegate restore — source guards", () => {
	const src = fs.readFileSync(
		path.join(process.cwd(), "src/server/agent/session-manager.ts"),
		"utf-8",
	);

	it("restoreSession has a delegate branch ordered before the goal/role else branch", () => {
		const idx = src.indexOf("private async restoreSession(ps: PersistedSession)");
		assert.ok(idx > 0, "restoreSession declaration not found");
		const window = src.slice(idx, idx + 20_000);

		const delegateBranchIdx = window.indexOf("} else if (ps.delegateOf && !ps.goalId) {");
		assert.ok(delegateBranchIdx > 0, "restoreSession must have an `else if (ps.delegateOf && !ps.goalId)` branch");

		// The delegate branch builds the task spec from instructions + context.
		const branchWindow = window.slice(delegateBranchIdx, delegateBranchIdx + 1200);
		assert.match(branchWindow, /let taskSpec = ps\.instructions \|\| ""/);
		assert.match(branchWindow, /for \(const \[key, value\] of Object\.entries\(ps\.context\)\)/);
		assert.match(branchWindow, /projectRoot: ps\.repoPath/);
		assert.match(branchWindow, /goalSpec: taskSpec/);

		// It must precede the goal/role else branch (which resolves goal?.spec).
		const goalElseIdx = window.indexOf("const goal = ps.goalId ? this.resolveGoal(ps.goalId) : undefined;");
		assert.ok(goalElseIdx > delegateBranchIdx, "delegate branch must come before the goal/role else branch");
	});

	it("restoreSessions restores surviving delegates LIVE, not as dormant husks", () => {
		const idx = src.indexOf("async restoreSessions(): Promise<void>");
		assert.ok(idx > 0, "restoreSessions declaration not found");
		const window = src.slice(idx, idx + 6_000);

		// Survivors are collected and routed through the live restore path.
		assert.match(window, /const delegateSurvivors: PersistedSession\[\] = \[\];/);
		assert.match(window, /const liveRestore = \[\.\.\.regular, \.\.\.delegateSurvivors\];/);
		assert.match(window, /liveRestore\.slice\(i, i \+ CONCURRENCY\)/);

		// The orphan boot-reap MUST stay in restoreSessions() (a stubbed
		// restoreOneSession test relies on it being here, before dispatch).
		const reapIdx = window.indexOf("shouldReapChildOnBoot({");
		const dispatchIdx = window.indexOf("batch.map(ps => this.restoreOneSession(ps))");
		assert.ok(reapIdx > 0, "delegate orphan reap must remain in restoreSessions()");
		assert.ok(dispatchIdx > reapIdx, "orphan reap must run before live restore dispatch");

		// Survivors must NOT be added as dormant placeholders anymore.
		assert.ok(
			!/delegates[\s\S]{0,200}this\.addDormantSession\(ps\)/.test(window),
			"surviving delegates must not be deferred via addDormantSession",
		);
	});

	it("persistOnce persists the durable delegate task (instructions + context)", () => {
		const setupSrc = fs.readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		const idx = setupSrc.indexOf("export function persistOnce(");
		assert.ok(idx > 0, "persistOnce declaration not found");
		const window = setupSrc.slice(idx, idx + 2_500);
		assert.match(window, /instructions: plan\.instructions,/);
		assert.match(window, /context: plan\.context,/);
	});
});
