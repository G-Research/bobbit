import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf8");
const { persistOnce, resolveBridgeOptions } = await import("../src/server/agent/session-setup.ts");

describe("session setup Claude Code pre-existing transcript recovery", () => {
	it("rejects Claude Code continue/fork transcript recovery without a Claude session id", () => {
		assert.match(SRC, /export function resolvePreExistingTranscriptSetupMode/);
		assert.match(SRC, /runtime !== "claude-code"\) return "switch-session"/);
		assert.match(SRC, /plan\.bridgeOptions\.claudeCodeSessionId \|\| plan\.claudeCodeSessionId\) return "claude-code-resume"/);
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

	it("threads plan Claude Code resume id through bridge option resolution", () => {
		const plan = {
			id: "bobbit-session",
			cwd: process.cwd(),
			runtime: "claude-code",
			initialModel: "claude-code/sonnet",
			claudeCodeSessionId: "claude-resume-123",
			skipAutoThinking: true,
			bridgeOptions: { cwd: process.cwd() },
		};
		const ctx = {
			sessionSecretStore: { getOrCreateSecret: () => "secret" },
			resolveInitialModel: () => undefined,
			resolveInitialThinkingLevel: () => undefined,
		};

		resolveBridgeOptions(plan as any, ctx as any);

		assert.equal((plan.bridgeOptions as any).claudeCodeSessionId, "claude-resume-123");
		assert.equal((plan.bridgeOptions as any).runtime, "claude-code");
	});

	it("preserves Claude Code resume id across replacement persistOnce calls", () => {
		const rows = new Map<string, any>();
		const store = {
			get: (id: string) => rows.get(id),
			put: (row: any) => rows.set(row.id, row),
		};
		const plan = {
			id: "bobbit-session",
			cwd: process.cwd(),
			runtime: "claude-code",
			initialModel: "claude-code/sonnet",
			preExistingAgentSessionFile: "/tmp/pre-existing.jsonl",
			bridgeOptions: {
				initialModel: "claude-code/sonnet",
				claudeCodeSessionId: "claude-resume-123",
				claudeCodeModelAlias: "sonnet",
			},
		};

		persistOnce({ id: "bobbit-session", title: "Preparing", cwd: process.cwd(), createdAt: 1, lastActivity: 1 }, plan as any, store as any);
		persistOnce({ id: "bobbit-session", title: "Ready", cwd: process.cwd(), createdAt: 2, lastActivity: 2 }, plan as any, store as any);

		assert.equal(rows.get("bobbit-session").claudeCodeSessionId, "claude-resume-123");
		assert.equal(rows.get("bobbit-session").runtime, "claude-code");

		rows.set("live-session", { id: "live-session", runtime: "claude-code", claudeCodeSessionId: "claude-live-456" });
		persistOnce(
			{ id: "live-session", title: "Ready", cwd: process.cwd(), createdAt: 3, lastActivity: 3 },
			{ ...plan, id: "live-session", bridgeOptions: { initialModel: "claude-code/sonnet", claudeCodeModelAlias: "sonnet" } } as any,
			store as any,
		);
		assert.equal(rows.get("live-session").claudeCodeSessionId, "claude-live-456");
	});
});
