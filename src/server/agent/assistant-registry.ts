import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

// Hardcoded fallback defaults
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

/** Hardcoded fallback defaults used when YAML files don't exist on disk. */
const FALLBACK_DEFAULTS: Record<string, AssistantDef> = {
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

/** Returns the path to the assistant YAML config directory. */
function assistantConfigDir(): string {
	return path.join(bobbitConfigDir(), "roles", "assistant");
}

/** Load a single assistant def from a YAML file, or return undefined. */
function loadYamlDef(filePath: string): AssistantDef | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const data = parse(content);
		if (data && typeof data.type === "string" && typeof data.prompt === "string") {
			return {
				type: data.type,
				title: data.title || data.type,
				promptTitle: data.promptTitle || data.title || data.type,
				prompt: data.prompt,
			};
		}
	} catch {
		// File doesn't exist or parse error — fall through
	}
	return undefined;
}

/** Build the registry by reading YAML files from disk, falling back to hardcoded defaults. */
function buildRegistry(): Record<string, AssistantDef> {
	const registry: Record<string, AssistantDef> = {};
	const configDir = assistantConfigDir();

	// 1. Read YAML files from disk
	if (fs.existsSync(configDir)) {
		try {
			for (const entry of fs.readdirSync(configDir)) {
				if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
				const filePath = path.join(configDir, entry);
				const def = loadYamlDef(filePath);
				if (def) {
					registry[def.type] = def;
				}
			}
		} catch {
			// Directory read error — fall through to defaults
		}
	}

	// 2. Fill in any missing types from hardcoded fallback defaults
	for (const [type, def] of Object.entries(FALLBACK_DEFAULTS)) {
		if (!registry[type]) {
			registry[type] = def;
		}
	}

	return registry;
}

// Initialize on first import
export let ASSISTANT_REGISTRY: Record<string, AssistantDef> = buildRegistry();

export function getAssistantDef(type: string): AssistantDef | undefined {
	return ASSISTANT_REGISTRY[type];
}

export function isAssistantType(type: string): boolean {
	return type in ASSISTANT_REGISTRY;
}

/** Re-read all assistant definitions from disk and rebuild the in-memory registry. */
export function reloadAssistantDefs(): void {
	ASSISTANT_REGISTRY = buildRegistry();
}

/**
 * Update an assistant definition. Writes to the YAML file on disk and updates
 * the in-memory registry. Returns the updated def, or undefined if the type
 * doesn't exist in the registry.
 */
export function updateAssistantDef(
	type: string,
	updates: { prompt?: string; title?: string; promptTitle?: string },
): AssistantDef | undefined {
	const existing = ASSISTANT_REGISTRY[type];
	if (!existing) return undefined;

	const updated: AssistantDef = {
		type,
		title: updates.title ?? existing.title,
		promptTitle: updates.promptTitle ?? existing.promptTitle,
		prompt: updates.prompt ?? existing.prompt,
	};

	// Write to disk
	const configDir = assistantConfigDir();
	fs.mkdirSync(configDir, { recursive: true });
	const filePath = path.join(configDir, `${type}.yaml`);
	const yamlContent = stringify({
		type: updated.type,
		title: updated.title,
		promptTitle: updated.promptTitle,
		prompt: updated.prompt,
	});
	fs.writeFileSync(filePath, yamlContent, "utf-8");

	// Update in-memory registry
	ASSISTANT_REGISTRY[type] = updated;

	return updated;
}
