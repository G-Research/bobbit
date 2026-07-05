/**
 * Pins for `isReadOnlyToolPolicy` (`src/server/agent/read-only-tool-policy.ts`,
 * eligibility-signal lane, TRACKER "eligibility-signal" item /
 * docs/design/in-process-bridge-spike.md "Sizing results (2026-07-05)").
 *
 * Fixtures below are REAL resolved tool lists, not invented shapes:
 *   - `PR_REVIEWER_RESOLVED_TOOLS` is exactly the PR Walkthrough group's tool
 *     set (`WALKTHROUGH_ALLOWED_TOOLS` in walkthrough-agent-manager.ts +
 *     market-packs/pr-walkthrough/roles/pr-reviewer.yaml's toolPolicies —
 *     `readonly_bash`, not `bash`) — the one role in the repo that is
 *     genuinely read-only by tool policy today.
 *   - `CODE_REVIEWER_RESOLVED_TOOLS` is the real output of
 *     `computeEffectiveAllowedTools` against `defaults/roles/reviewer.yaml`
 *     (and identically `code-reviewer`/`security-reviewer`/`spec-auditor`/
 *     `bug-hunter`/`architect`), verified empirically while building this
 *     predicate: none of the built-in "reviewer-shaped" roles deny `bash` or
 *     `write` (only `edit`/`bash_bg`/`team_delegate`/goal-mutation tools are
 *     denied — both default-allow at the group level per
 *     `defaults/tool-group-policies.yaml`), so the resolved set is a ~52-tool
 *     surface that DOES include `bash`+`write`. This documents the honest
 *     finding: today's built-in gate-verify reviewer roles are NOT read-only
 *     under this predicate (they use unpoliced `bash` for `git diff`), unlike
 *     PR #157's static-grep census which missed the default-allow.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { isReadOnlyToolPolicy, MUTATING_TOOLS } = await import("../src/server/agent/read-only-tool-policy.ts");

const PR_REVIEWER_RESOLVED_TOOLS = [
	"readonly_bash",
	"read_pr_walkthrough_bundle",
	"submit_pr_walkthrough_chunk",
	"read_pr_walkthrough_submission_status",
	"finalize_pr_walkthrough_submission",
	"submit_pr_walkthrough_yaml",
];

// Real computeEffectiveAllowedTools() output for defaults/roles/reviewer.yaml
// (identical shape for code-reviewer/security-reviewer/spec-auditor/
// bug-hunter/architect — verified 2026-07-05).
const CODE_REVIEWER_RESOLVED_TOOLS = [
	"activate_skill", "ask_user_choices", "bash", "browser_click", "browser_console_messages",
	"browser_eval", "browser_hover", "browser_navigate", "browser_press_key", "browser_resize",
	"browser_screenshot", "browser_select_option", "browser_snapshot", "browser_type", "browser_wait",
	"edit_proposal", "find", "gate_inspect", "gate_list", "gate_status", "generate_image", "grep",
	"inbox_complete", "inbox_dismiss", "inbox_list", "ls", "mcp_describe", "orient", "preview_open",
	"propose_goal", "propose_project", "propose_role", "propose_staff", "propose_tool", "read",
	"read_session", "review_close", "review_open", "task_create", "task_list", "task_update",
	"team_abort", "team_dismiss", "team_prompt", "team_steer", "team_wait", "verification_result",
	"view_goal_spec", "view_proposal", "web_fetch", "web_search", "write",
];

const CODER_DELEGATE_RESOLVED_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash", "bash_bg"];

describe("isReadOnlyToolPolicy (eligibility-signal predicate)", () => {
	it("a genuinely read-only reviewer role's resolved list -> true (pr-reviewer: readonly_bash, no bash/write/edit)", () => {
		assert.equal(isReadOnlyToolPolicy(PR_REVIEWER_RESOLVED_TOOLS), true);
	});

	it("a coder delegate's resolved list (edit/write/bash present) -> false", () => {
		assert.equal(isReadOnlyToolPolicy(CODER_DELEGATE_RESOLVED_TOOLS), false);
	});

	it("an unknown/MCP tool present -> false (fails closed, not silently treated as safe)", () => {
		assert.equal(isReadOnlyToolPolicy(["read", "grep", "mcp__github__create_pr"]), false);
		assert.equal(isReadOnlyToolPolicy(["read", "grep", "mcp_playwright__click"]), false);
	});

	it("honest finding: the built-in code-reviewer role's REAL resolved list is NOT read-only (bash+write default-allow)", () => {
		assert.equal(isReadOnlyToolPolicy(CODE_REVIEWER_RESOLVED_TOOLS), false);
		// Specifically because of bash/write, not some other tool in the 52-tool set:
		assert.ok(CODE_REVIEWER_RESOLVED_TOOLS.includes("bash"));
		assert.ok(CODE_REVIEWER_RESOLVED_TOOLS.includes("write"));
	});

	it("undefined (unrestricted) fails closed -> false", () => {
		assert.equal(isReadOnlyToolPolicy(undefined), false);
	});

	it("explicit empty allowlist is vacuously read-only -> true", () => {
		assert.equal(isReadOnlyToolPolicy([]), true);
	});

	it("case-insensitive tool-name matching", () => {
		assert.equal(isReadOnlyToolPolicy(["Read", "BASH"]), false);
		assert.equal(isReadOnlyToolPolicy(["Read", "Grep"]), true);
	});

	it("MUTATING_TOOLS is the exact deny-set (single source of truth with orchestration-core's READ_ONLY_DENY_TOOLS)", () => {
		assert.deepEqual([...MUTATING_TOOLS].sort(), ["bash", "bash_bg", "edit", "generate_image", "write"]);
	});
});
