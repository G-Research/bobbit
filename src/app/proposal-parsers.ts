/**
 * Each `on*Proposal` callback now accepts a second `streaming: boolean`
 * argument. `streaming === true` means input is still arriving; consumers
 * must keep their `*Edited` gating intact and must not commit destructive
 * actions on streaming-mode fires. The streaming flag itself is owned by
 * `state.ts` (see `proposalStreamingByTag` / `isProposalStreaming`).
 *
 * Slice D note: `callbackName` was dropped. After Slice E, the unified
 * `RemoteAgent.onProposal(type, fields, streaming)` callback subsumes the
 * per-type callback names, and `_checkProposals` (the legacy XML fallback
 * still in `remote-agent.ts`) maps the `tag` field directly to a
 * `ProposalType`. This file is now used ONLY by the legacy XML fallback.
 */
export interface ProposalParser {
	tag: string;
	fields: string[];
	requiredFields: string[];
}

export const PROPOSAL_PARSERS: ProposalParser[] = [
	{
		tag: "goal_proposal",
		fields: ["title", "spec", "cwd", "workflow", "options"],
		requiredFields: ["title", "spec"],
	},
	{
		tag: "role_proposal",
		fields: ["name", "label", "prompt", "tools", "accessory"],
		requiredFields: ["name", "label", "prompt"],
	},
	{
		tag: "tool_proposal",
		fields: ["tool", "action", "content"],
		requiredFields: ["tool", "action", "content"],
	},
	{
		tag: "staff_proposal",
		fields: ["name", "description", "prompt", "triggers", "cwd"],
		requiredFields: ["name", "prompt"],
	},
	{
		tag: "workflow_proposal",
		fields: ["id", "name", "description", "gates"],
		requiredFields: ["id", "name"],
	},
	{
		tag: "project_proposal",
		fields: ["name", "root_path", "build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command", "worktree_setup_command", "qa_start_command", "qa_build_command", "qa_health_check", "qa_browser_entry", "worktree_root", "worktree_pool_size"],
		requiredFields: ["name", "root_path"],
	},
];
