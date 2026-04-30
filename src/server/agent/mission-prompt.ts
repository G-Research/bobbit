/**
 * Mission-aware prompt substitutions for the Commander role.
 *
 * Centralises the {{MISSION_TITLE}} / {{INTEGRATION_BRANCH}} /
 * {{MAX_CONCURRENT_GOALS}} / {{MISSION_ID}} / {{REVIEW_CONTEXT}} replacements
 * so the initial-spawn site (server.ts) and every restart/respawn site
 * (session-manager.ts) share one implementation.
 *
 * Bug regression: until this helper landed, restoreSession only substituted
 * {{GOAL_BRANCH}}, {{AGENT_ID}}, {{AVAILABLE_ROLES}} — leaving literal
 * `{{MISSION_TITLE}}` text in the resolved Commander system prompt after
 * gateway restart.
 */

import type { PersistedMission } from "./mission-store.js";

/**
 * Apply mission-specific placeholder substitutions to a role prompt template.
 *
 * Returns the template unchanged when `mission` is undefined. Always replaces
 * every occurrence (global flag) so a single template can mention a placeholder
 * more than once.
 *
 * Placeholders covered:
 *   - {{MISSION_TITLE}}         → mission.title
 *   - {{INTEGRATION_BRANCH}}    → mission.integrationBranch ?? ""
 *   - {{MAX_CONCURRENT_GOALS}}  → String(mission.maxConcurrentGoals)
 *   - {{MISSION_ID}}            → mission.id
 *   - {{REVIEW_CONTEXT}}        → "" (placeholder for verification reviewer
 *                                  prompts; Commander never has review context)
 *
 * `{{AGENT_ID}}` and `{{AVAILABLE_ROLES}}` are NOT touched here — those are
 * generic role-prompt vars handled by the caller.
 */
export function applyMissionPromptSubstitutions(
	template: string,
	mission: PersistedMission | undefined,
): string {
	if (!mission) return template;
	return template
		.replace(/\{\{MISSION_TITLE\}\}/g, mission.title)
		.replace(/\{\{INTEGRATION_BRANCH\}\}/g, mission.integrationBranch || "")
		.replace(/\{\{MAX_CONCURRENT_GOALS\}\}/g, String(mission.maxConcurrentGoals))
		.replace(/\{\{MISSION_ID\}\}/g, mission.id)
		.replace(/\{\{REVIEW_CONTEXT\}\}/g, "");
}
