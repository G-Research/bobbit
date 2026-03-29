export interface ProposalParser {
	tag: string;
	fields: string[];
	requiredFields: string[];
	callbackName: string;
}

export const PROPOSAL_PARSERS: ProposalParser[] = [
	{
		tag: "goal_proposal",
		fields: ["title", "spec", "cwd", "workflow"],
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
		tag: "personality_proposal",
		fields: ["name", "label", "description", "prompt_fragment"],
		requiredFields: ["name", "label", "prompt_fragment"],
		callbackName: "onPersonalityProposal",
	},
	{
		tag: "staff_proposal",
		fields: ["name", "description", "prompt", "triggers", "cwd"],
		requiredFields: ["name", "prompt"],
		callbackName: "onStaffProposal",
	},
	{
		tag: "setup_proposal",
		fields: ["action", "content", "language", "framework", "testing", "build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command", "session_model", "review_model", "naming_model", "system_prompt_context"],
		requiredFields: ["action"],
		callbackName: "onSetupProposal",
	},
	{
		tag: "workflow_proposal",
		fields: ["id", "name", "description", "gates"],
		requiredFields: ["id", "name"],
		callbackName: "onWorkflowProposal",
	},
];
