import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf8");

describe("session setup Claude Code pre-existing transcript recovery", () => {
	it("rejects Claude Code continue/fork transcript recovery without a Claude session id", () => {
		assert.match(SRC, /export function resolvePreExistingTranscriptSetupMode/);
		assert.match(SRC, /runtime !== "claude-code"\) return "switch-session"/);
		assert.match(SRC, /plan\.bridgeOptions\.claudeCodeSessionId\) return "claude-code-resume"/);
		assert.match(SRC, /Continue\/fork from a Bobbit transcript is not supported for Claude Code runtime in the MVP/);
		assert.match(SRC, /Pi switch_session cannot be used with Claude Code/);
	});

	it("gates every switch_session command behind the Pi-only mode", () => {
		let idx = -1;
		let count = 0;
		while ((idx = SRC.indexOf('{ type: "switch_session"', idx + 1)) !== -1) {
			count++;
			const before = SRC.slice(Math.max(0, idx - 3200), idx);
			const after = SRC.slice(idx, Math.min(SRC.length, idx + 900));
			assert.match(before, /const preExistingMode = resolvePreExistingTranscriptSetupMode\(plan\);[\s\S]*if \(preExistingMode === "switch-session"\) \{/);
			assert.match(after, /else if \(preExistingMode === "claude-code-resume"\)/);
		}
		assert.equal(count, 2, "session-setup should only have the worktree and normal/delegate switch_session paths");
	});

	it("validates unsupported Claude Code transcript recovery before spawning", () => {
		const executePlanIdx = SRC.indexOf("export async function executePlan");
		const executePersistIdx = SRC.indexOf("persistOnce(preSpawnSession", executePlanIdx);
		const executeValidateIdx = SRC.indexOf("resolvePreExistingTranscriptSetupMode(plan);", executePlanIdx);
		assert.ok(executeValidateIdx > executePlanIdx && executeValidateIdx < executePersistIdx);

		const worktreeIdx = SRC.indexOf("export async function executeWorktreeAsync");
		const worktreeBridgeIdx = SRC.indexOf("const rpcClient = createSessionBridge", worktreeIdx);
		const worktreeValidateIdx = SRC.indexOf("resolvePreExistingTranscriptSetupMode(plan);", worktreeIdx);
		assert.ok(worktreeValidateIdx > worktreeIdx && worktreeValidateIdx < worktreeBridgeIdx);
	});
});
