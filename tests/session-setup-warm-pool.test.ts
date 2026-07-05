/**
 * Unit tests for the warm-pool wave-1 integration points in session-setup.ts
 * (docs/design/warm-pi-process-pool.md):
 *   - `isWarmPoolEligible` — the eligibility gate (narrower than the doc's
 *     literal "exec class only" — see that function's doc comment for why).
 *   - `computeWarmPoolKey` — keying: different cwd/extension-set/project
 *     never collide.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWarmPoolEligible, computeWarmPoolKey } from "../src/server/agent/session-setup.ts";
import type { SessionSetupPlan } from "../src/server/agent/session-setup.ts";

function basePlan(overrides: Partial<SessionSetupPlan> = {}): SessionSetupPlan {
	return {
		id: "session-1",
		mode: "normal",
		title: "New session",
		cwd: "/repo",
		projectId: "proj-1",
		bridgeOptions: { cwd: "/repo", args: ["--extension", "/tools/shell/extension.ts"] },
		...overrides,
	} as SessionSetupPlan;
}

describe("isWarmPoolEligible", () => {
	it("a plain non-goal, non-sandboxed, non-readonly session with a projectId is eligible", () => {
		assert.equal(isWarmPoolEligible(basePlan()), true);
	});

	it("excludes sandboxed sessions", () => {
		assert.equal(isWarmPoolEligible(basePlan({ sandboxed: true })), false);
	});

	it("excludes sessions with a container id (docker exec path)", () => {
		assert.equal(isWarmPoolEligible(basePlan({ bridgeOptions: { cwd: "/repo", containerId: "c1" } })), false);
	});

	it("excludes readOnly sessions (a different class — in-process-bridge territory)", () => {
		assert.equal(isWarmPoolEligible(basePlan({ readOnly: true })), false);
	});

	it("excludes goal-scoped sessions (BOBBIT_GOAL_ID is spawn-baked, no RPC to fix post-claim)", () => {
		assert.equal(isWarmPoolEligible(basePlan({ goalId: "goal-1" })), false);
	});

	it("excludes team-goal-scoped sessions", () => {
		assert.equal(isWarmPoolEligible(basePlan({ teamGoalId: "goal-1" })), false);
	});

	it("excludes assistant sessions", () => {
		assert.equal(isWarmPoolEligible(basePlan({ assistantType: "goal" })), false);
	});

	it("excludes delegate/child sessions", () => {
		assert.equal(isWarmPoolEligible(basePlan({ delegateOf: "parent-1" })), false);
		assert.equal(isWarmPoolEligible(basePlan({ parentSessionId: "parent-1" })), false);
		assert.equal(isWarmPoolEligible(basePlan({ childKind: "pr-walkthrough" })), false);
	});

	it("excludes resume-from-transcript sessions (continue/fork)", () => {
		assert.equal(isWarmPoolEligible(basePlan({ preExistingAgentSessionFile: "/tmp/x.jsonl" })), false);
	});

	it("excludes claude-code sessions", () => {
		assert.equal(isWarmPoolEligible(basePlan({ claudeCodeSessionId: "cc-1" })), false);
		assert.equal(isWarmPoolEligible(basePlan({ bridgeOptions: { cwd: "/repo", runtime: "claude-code" } })), false);
	});

	it("excludes sessions with caller-supplied custom env", () => {
		assert.equal(isWarmPoolEligible(basePlan({ env: { FOO: "bar" } })), false);
	});

	it("does not exclude a plan with an explicit but EMPTY env object", () => {
		assert.equal(isWarmPoolEligible(basePlan({ env: {} })), true);
	});

	it("does NOT exclude plan.env carrying only SessionManager's own directGatewayEnv keys (BOBBIT_GATEWAY_URL/BOBBIT_TOKEN)", () => {
		// Regression pin: found live via an E2E trace that SessionManager.
		// createSession() unconditionally merges its own directGatewayEnv into
		// opts.env for EVERY non-sandboxed session, so a naive "any plan.env at
		// all disqualifies" check rejected virtually the entire target
		// population, not just genuine custom toolEnv.
		assert.equal(isWarmPoolEligible(basePlan({ env: { BOBBIT_GATEWAY_URL: "http://127.0.0.1:1234", BOBBIT_TOKEN: "abc123" } })), true);
	});

	it("still excludes a plan whose env mixes a known-safe key with a genuinely custom one", () => {
		assert.equal(isWarmPoolEligible(basePlan({ env: { BOBBIT_GATEWAY_URL: "http://127.0.0.1:1234", CUSTOM_VAR: "x" } })), false);
	});

	it("excludes sessions with raw caller-supplied agentArgs", () => {
		assert.equal(isWarmPoolEligible(basePlan({ agentArgs: ["--foo"] })), false);
	});

	it("excludes sessions with no projectId (pool key requires a stable project scope)", () => {
		assert.equal(isWarmPoolEligible(basePlan({ projectId: undefined })), false);
	});
});

describe("computeWarmPoolKey", () => {
	it("is stable for the same (projectId, cwd, resolved args, systemPromptPath)", () => {
		const a = computeWarmPoolKey(basePlan());
		const b = computeWarmPoolKey(basePlan());
		assert.equal(a, b);
	});

	it("differs for a different cwd", () => {
		const a = computeWarmPoolKey(basePlan());
		const b = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/other-repo", args: ["--extension", "/tools/shell/extension.ts"] } }));
		assert.notEqual(a, b);
	});

	it("differs for a different projectId (same cwd/args)", () => {
		const a = computeWarmPoolKey(basePlan({ projectId: "proj-1" }));
		const b = computeWarmPoolKey(basePlan({ projectId: "proj-2" }));
		assert.notEqual(a, b);
	});

	it("differs for a different resolved extension/tool-activation arg list (role/tool-policy shape)", () => {
		const a = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: ["--extension", "/tools/shell/extension.ts"] } }));
		const b = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: ["--extension", "/tools/shell/extension.ts", "--extension", "/tools/web/extension.ts"] } }));
		assert.notEqual(a, b);
	});

	it("differs for a different systemPromptPath", () => {
		const a = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: [], systemPromptPath: "/prompts/a.md" } }));
		const b = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: [], systemPromptPath: "/prompts/b.md" } }));
		assert.notEqual(a, b);
	});

	it("does NOT vary with initialModel/initialThinkingLevel (covered by post-claim set_model/set_thinking_level, not the key)", () => {
		const a = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: [], initialModel: "anthropic/claude-1" } }));
		const b = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: [], initialModel: "anthropic/claude-2", initialThinkingLevel: "high" } }));
		assert.equal(a, b);
	});
});

/**
 * Regression coverage for a bug found live via an E2E trace: several
 * generated extensions (tool-guard-extension.ts, provider-bridge-
 * extension.ts, google-code-assist-provider-extension.ts) embed the
 * session's OWN id as a `JSON.stringify(sessionId)` literal in the
 * generated CODE, written under a `sha256(code)`-named directory — so the
 * PATH differs for every session even when role/tool-policy is byte-for-
 * byte identical, and naively hashing raw CONTENT reproduces the exact same
 * problem (the content itself still differs by the embedded id). The fix:
 * hash file content with the CURRENT plan's own id redacted first.
 */
describe("computeWarmPoolKey — content hashing + session-id redaction", () => {
	const tmpDirs: string[] = [];
	after(() => {
		for (const dir of tmpDirs) {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
	function writeTmpFile(content: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-warmpool-key-test-"));
		tmpDirs.push(dir);
		const file = path.join(dir, "extension.ts");
		fs.writeFileSync(file, content, "utf-8");
		return file;
	}

	it("two DIFFERENT paths with IDENTICAL content hash to the SAME key (content, not path, is what matters)", () => {
		const fileA = writeTmpFile("export default function(pi) { /* static tool extension */ }");
		const fileB = writeTmpFile("export default function(pi) { /* static tool extension */ }");
		const a = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: ["--extension", fileA] } }));
		const b = computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: ["--extension", fileB] } }));
		assert.equal(a, b);
	});

	it("two sessions whose generated file embeds their OWN (different) session id, otherwise identical, hash to the SAME key", () => {
		// Mirrors tool-guard-extension.ts:78's `const sessionId = ${JSON.stringify(sessionId)};` pattern.
		const fileForSessionA = writeTmpFile(`const sessionId = "session-aaaa";\nconst policy = { bash: "ask" };\n`);
		const fileForSessionB = writeTmpFile(`const sessionId = "session-bbbb";\nconst policy = { bash: "ask" };\n`);
		const a = computeWarmPoolKey(basePlan({ id: "session-aaaa", bridgeOptions: { cwd: "/repo", args: ["--extension", fileForSessionA] } }));
		const b = computeWarmPoolKey(basePlan({ id: "session-bbbb", bridgeOptions: { cwd: "/repo", args: ["--extension", fileForSessionB] } }));
		assert.equal(a, b, "redacting each plan's own id must collapse these to the same fingerprint");
	});

	it("a REAL content difference (not just the id) still produces a different key", () => {
		const fileForSessionA = writeTmpFile(`const sessionId = "session-aaaa";\nconst policy = { bash: "ask" };\n`);
		const fileForSessionB = writeTmpFile(`const sessionId = "session-bbbb";\nconst policy = { bash: "never" };\n`);
		const a = computeWarmPoolKey(basePlan({ id: "session-aaaa", bridgeOptions: { cwd: "/repo", args: ["--extension", fileForSessionA] } }));
		const b = computeWarmPoolKey(basePlan({ id: "session-bbbb", bridgeOptions: { cwd: "/repo", args: ["--extension", fileForSessionB] } }));
		assert.notEqual(a, b, "a genuine tool-policy difference must not be redacted away");
	});

	it("systemPromptPath is also content-hashed with id redaction (session-prompts/<id>.md is always named per-session)", () => {
		const promptA = writeTmpFile("You are a helpful coding assistant for session-aaaa.");
		const promptB = writeTmpFile("You are a helpful coding assistant for session-bbbb.");
		// Same content template, just the embedded id differs — same as
		// session-prompts/<id>.md's actual naming/content pattern.
		fs.writeFileSync(promptA, "You are a helpful coding assistant for session-aaaa.");
		fs.writeFileSync(promptB, "You are a helpful coding assistant for session-bbbb.");
		const a = computeWarmPoolKey(basePlan({ id: "session-aaaa", bridgeOptions: { cwd: "/repo", args: [], systemPromptPath: promptA } }));
		const b = computeWarmPoolKey(basePlan({ id: "session-bbbb", bridgeOptions: { cwd: "/repo", args: [], systemPromptPath: promptB } }));
		assert.equal(a, b);
	});

	it("falls back to raw path comparison when the referenced file doesn't exist (never throws)", () => {
		assert.doesNotThrow(() => computeWarmPoolKey(basePlan({ bridgeOptions: { cwd: "/repo", args: ["--extension", "/does/not/exist.ts"] } })));
	});
});
