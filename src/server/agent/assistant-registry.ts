import { GOAL_ASSISTANT_PROMPT } from "./goal-assistant.js";
import { ROLE_ASSISTANT_PROMPT } from "./role-assistant.js";
import { TOOL_ASSISTANT_PROMPT } from "./tool-assistant.js";
import { PERSONALITY_ASSISTANT_PROMPT } from "./personality-assistant.js";
import { STAFF_ASSISTANT_PROMPT } from "./staff-assistant.js";
import { SETUP_ASSISTANT_PROMPT } from "./setup-assistant.js";

export interface AssistantDef {
	type: string;
	title: string;
	promptTitle: string;
	prompt: string;
}

export const ASSISTANT_REGISTRY: Record<string, AssistantDef> = {
	goal: {
		type: "goal",
		title: "Goal Assistant",
		promptTitle: "Goal Creation Assistant",
		prompt: GOAL_ASSISTANT_PROMPT,
	},
	role: {
		type: "role",
		title: "Role Assistant",
		promptTitle: "Role Creation Assistant",
		prompt: ROLE_ASSISTANT_PROMPT,
	},
	tool: {
		type: "tool",
		title: "Tool Assistant",
		promptTitle: "Tool Management Assistant",
		prompt: TOOL_ASSISTANT_PROMPT,
	},
	personality: {
		type: "personality",
		title: "Personality Assistant",
		promptTitle: "Personality Creation Assistant",
		prompt: PERSONALITY_ASSISTANT_PROMPT,
	},
	staff: {
		type: "staff",
		title: "Staff Assistant",
		promptTitle: "Staff Agent Creation Assistant",
		prompt: STAFF_ASSISTANT_PROMPT,
	},
	setup: {
		type: "setup",
		title: "Setup Wizard",
		promptTitle: "Project Setup Assistant",
		prompt: SETUP_ASSISTANT_PROMPT,
	},
};

export function getAssistantDef(type: string): AssistantDef | undefined {
	return ASSISTANT_REGISTRY[type];
}

export function isAssistantType(type: string): boolean {
	return type in ASSISTANT_REGISTRY;
}
