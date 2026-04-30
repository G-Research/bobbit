/**
 * Each `on*Proposal` callback now accepts a second `streaming: boolean`
 * argument. `streaming === true` means input is still arriving; consumers
 * must keep their `*Edited` gating intact and must not commit destructive
 * actions on streaming-mode fires. The streaming flag itself is owned by
 * `state.ts` (see `proposalStreamingByTag` / `isProposalStreaming`).
 */
export interface ProposalParser {
	tag: string;
	fields: string[];
	requiredFields: string[];
	callbackName: string;
}

export const PROPOSAL_PARSERS: ProposalParser[] = [
	{
		tag: "goal_proposal",
		fields: ["title", "spec", "cwd", "workflow", "options"],
		requiredFields: ["title", "spec"],
		callbackName: "onGoalProposal",
	},
	{
		tag: "role_proposal",
		fields: ["name", "label", "prompt", "tools", "accessory"],
		requiredFields: ["name", "label", "prompt"],
		callbackName: "onRoleProposal",
	},
	{
		tag: "tool_proposal",
		fields: ["tool", "action", "content"],
		requiredFields: ["tool", "action", "content"],
		callbackName: "onToolProposal",
	},
	{
		tag: "staff_proposal",
		fields: ["name", "description", "prompt", "triggers", "cwd"],
		requiredFields: ["name", "prompt"],
		callbackName: "onStaffProposal",
	},
	{
		tag: "setup_proposal",
		fields: ["action", "content", "language", "framework", "testing", "build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command"],
		requiredFields: ["action"],
		callbackName: "onSetupProposal",
	},
	{
		tag: "workflow_proposal",
		fields: ["id", "name", "description", "gates"],
		requiredFields: ["id", "name"],
		callbackName: "onWorkflowProposal",
	},
	{
		tag: "project_proposal",
		fields: ["name", "root_path", "build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command", "worktree_setup_command", "qa_start_command", "qa_build_command", "qa_health_check", "qa_browser_entry", "worktree_root", "worktree_pool_size"],
		requiredFields: ["name", "root_path"],
		callbackName: "onProjectProposal",
	},
];
