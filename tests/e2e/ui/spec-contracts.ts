/**
 * Cross-feature contracts for the Bobbit specification framework.
 *
 * Each contract defines a guarantee that must hold across multiple variations
 * (server restart, page reload, rapid interactions, etc.). Stories reference
 * contracts by ID; the spec graph uses them for coverage analysis.
 */
import { defineContract } from "./spec-framework.js";

// ────────────────────────────────────────────────────────────
// CT-01: Streaming lifecycle
// ────────────────────────────────────────────────────────────

export const CT_01 = defineContract({
	id: "CT-01",
	guarantee: "Streaming lifecycle drives prompt controls, preserves partial work, and updates cost",
	survives: [
		"rapid-sends-while-streaming",
		"abort-mid-stream",
		"session-switch-during-stream",
		"re-send-after-abort",
		"page-reload",
		"concurrent-agent-sessions",
	],
	regions: ["editor", "message_list", "context_bar", "stats_bar"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-02: Session switch preserves drafts
// ────────────────────────────────────────────────────────────

export const CT_02 = defineContract({
	id: "CT-02",
	guarantee: "Session switch preserves drafts and context",
	survives: [
		"rapid-session-switch",
		"settings-detour",
		"model-change",
		"page-reload",
		"goal-dashboard-detour",
		"attachment-added",
		"personality-change",
		"reconnect-after-disconnect",
	],
	regions: ["editor", "context_bar"],
	depends_on: ["CT-05"],
});

// ────────────────────────────────────────────────────────────
// CT-03: Session switch updates sidebar
// ────────────────────────────────────────────────────────────

export const CT_03 = defineContract({
	id: "CT-03",
	guarantee: "Session switch updates the sidebar",
	survives: [
		"deep-link-navigation",
		"back-forward-navigation",
		"page-reload",
		"collapsed-tree-expansion",
	],
	regions: ["sidebar"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-04: Sidebar reflects live status
// ────────────────────────────────────────────────────────────

export const CT_04 = defineContract({
	id: "CT-04",
	guarantee: "Sidebar reflects live session and agent status",
	survives: [
		"page-reload",
		"agent-crash-restart",
		"concurrent-agents",
	],
	regions: ["sidebar"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-05: Page reload and reconnect restore state
// ────────────────────────────────────────────────────────────

export const CT_05 = defineContract({
	id: "CT-05",
	guarantee: "Page reload and reconnect restore full state",
	survives: [
		"browser-refresh",
		"browser-crash-reopen",
		"server-crash-restart",
		"network-reconnect",
	],
	regions: ["sidebar", "editor", "message_list", "context_bar", "dashboard"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-06: Focus follows intent
// ────────────────────────────────────────────────────────────

export const CT_06 = defineContract({
	id: "CT-06",
	guarantee: "Focus follows the user's intent",
	survives: [
		"rapid-session-switch",
		"dialog-close",
	],
	regions: ["editor", "modal"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-07: Goal creation sets up workspace
// ────────────────────────────────────────────────────────────

export const CT_07 = defineContract({
	id: "CT-07",
	guarantee: "Goal creation sets up the full workspace",
	survives: [
		"server-restart-after-creation",
	],
	regions: ["sidebar", "dashboard"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-08: Team agents nested under goal
// ────────────────────────────────────────────────────────────

export const CT_08 = defineContract({
	id: "CT-08",
	guarantee: "Team agents appear nested under their goal",
	survives: [
		"page-reload",
		"agent-crash-restart",
		"server-restart",
	],
	regions: ["sidebar"],
	depends_on: ["CT-07"],
});

// ────────────────────────────────────────────────────────────
// CT-09: Gates enforce workflow ordering
// ────────────────────────────────────────────────────────────

export const CT_09 = defineContract({
	id: "CT-09",
	guarantee: "Gates enforce workflow ordering and dashboard displays progress",
	survives: [
		"server-restart",
		"verification-failure",
		"page-reload",
		"live-verification-update",
	],
	regions: ["dashboard"],
	depends_on: ["CT-07"],
});

// ────────────────────────────────────────────────────────────
// CT-10: Task completion carries git handoff
// ────────────────────────────────────────────────────────────

export const CT_10 = defineContract({
	id: "CT-10",
	guarantee: "Task completion carries git handoff data",
	survives: [
		"server-restart",
		"agent-dismissal-after-completion",
	],
	regions: ["dashboard"],
	depends_on: ["CT-09"],
});

// ────────────────────────────────────────────────────────────
// CT-11: Goal completion archives and cleans up
// ────────────────────────────────────────────────────────────

export const CT_11 = defineContract({
	id: "CT-11",
	guarantee: "Goal completion archives and cleans up",
	survives: [
		"page-reload",
	],
	regions: ["sidebar"],
	depends_on: ["CT-08", "CT-09"],
});

// ────────────────────────────────────────────────────────────
// CT-12: Staff agents trigger and pause
// ────────────────────────────────────────────────────────────

export const CT_12 = defineContract({
	id: "CT-12",
	guarantee: "Staff agents trigger and pause on schedule",
	survives: [
		"server-restart",
		"page-reload",
	],
	regions: ["sidebar", "settings"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-13: URL routing determines view
// ────────────────────────────────────────────────────────────

export const CT_13 = defineContract({
	id: "CT-13",
	guarantee: "URL routing determines the displayed view and scopes keyboard shortcuts",
	survives: [
		"page-reload",
		"back-forward-navigation",
		"bookmarks",
		"view-transitions",
	],
	regions: ["sidebar", "editor", "dashboard", "settings", "search_page"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-14: Search indexes and navigates
// ────────────────────────────────────────────────────────────

export const CT_14 = defineContract({
	id: "CT-14",
	guarantee: "Search indexes content and navigates to results",
	survives: [
		"page-reload",
		"server-restart",
		"project-changes",
	],
	regions: ["search_page", "sidebar"],
	depends_on: ["CT-13"],
});

// ────────────────────────────────────────────────────────────
// CT-15: Config changes apply without restart
// ────────────────────────────────────────────────────────────

export const CT_15 = defineContract({
	id: "CT-15",
	guarantee: "Config changes apply without restart",
	survives: [
		"page-reload",
		"server-restart",
		"project-changes",
	],
	regions: ["settings", "context_bar"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-16: Projects organize sessions
// ────────────────────────────────────────────────────────────

export const CT_16 = defineContract({
	id: "CT-16",
	guarantee: "Projects organize sessions and scope configuration",
	survives: [
		"page-reload",
		"server-restart",
	],
	regions: ["sidebar", "settings"],
	depends_on: [],
});

// ────────────────────────────────────────────────────────────
// CT-17: Sandbox isolates commands
// ────────────────────────────────────────────────────────────

export const CT_17 = defineContract({
	id: "CT-17",
	guarantee: "Sandbox isolates commands from the host",
	survives: [
		"server-restart",
		"server-crash",
		"session-switch",
	],
	regions: ["message_list"],
	depends_on: ["CT-05"],
});

// ────────────────────────────────────────────────────────────
// ALL CONTRACTS
// ────────────────────────────────────────────────────────────

export const ALL_CONTRACTS = [
	CT_01, CT_02, CT_03, CT_04, CT_05, CT_06, CT_07, CT_08, CT_09,
	CT_10, CT_11, CT_12, CT_13, CT_14, CT_15, CT_16, CT_17,
];
