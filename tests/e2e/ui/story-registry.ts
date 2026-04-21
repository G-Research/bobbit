/**
 * Story metadata registry — imported by both test files and spec-check tool.
 * Contains defineStory() calls that register stories in the spec graph.
 * No Playwright dependencies — safe to import from standalone tools.
 */
import { defineStory } from "./spec-framework.js";
import { CT_01, CT_02, CT_03, CT_04, CT_05, CT_06, CT_13, CT_15, CT_16, CT_17, CT_18, CT_19 } from "./spec-contracts.js";

// ── Draft Preservation stories (CT-02) ──

export const STORY_CT02_A = defineStory({
	id: "CT-02-a",
	title: "Draft survives rapid session switching",
	contracts: [CT_02],
	covers: ["rapid-session-switch"],
});

export const STORY_CT02_B = defineStory({
	id: "CT-02-b",
	title: "Draft with attachment survives settings detour",
	contracts: [CT_02, CT_13],
	covers: ["settings-detour", "attachment-added"],
});

export const STORY_CT02_C = defineStory({
	id: "CT-02-c",
	title: "Draft survives model change",
	contracts: [CT_02, CT_15],
	covers: ["model-change"],
});

export const STORY_CT02_D = defineStory({
	id: "CT-02-d",
	title: "Draft survives page reload",
	contracts: [CT_02, CT_05],
	covers: ["page-reload"],
});

export const STORY_CT02_E = defineStory({
	id: "CT-02-e",
	title: "Draft survives goal dashboard detour",
	contracts: [CT_02],
	covers: ["goal-dashboard-detour"],
});

export const STORY_CT02_F = defineStory({
	id: "CT-02-f",
	title: "Draft survives personality change",
	contracts: [CT_02],
	covers: ["personality-change"],
});

export const STORY_CT02_G = defineStory({
	id: "CT-02-g",
	title: "Draft survives reconnect after disconnect",
	contracts: [CT_02, CT_05],
	covers: ["reconnect-after-disconnect"],
});

// ── Streaming Lifecycle stories (CT-01) ──

export const STORY_CT01_A = defineStory({
	id: "CT-01-a",
	title: "Send message and observe streaming lifecycle",
	contracts: [CT_01, CT_06],
	covers: [],
});

export const STORY_CT01_B = defineStory({
	id: "CT-01-b",
	title: "Abort mid-stream preserves partial response",
	contracts: [CT_01, CT_06],
	covers: ["abort-mid-stream"],
});

export const STORY_CT01_C = defineStory({
	id: "CT-01-c",
	title: "Re-send after abort",
	contracts: [CT_01],
	covers: ["re-send-after-abort"],
});

export const STORY_CT01_D = defineStory({
	id: "CT-01-d",
	title: "Rapid sends while streaming queue messages",
	contracts: [CT_01],
	covers: ["rapid-sends-while-streaming"],
});

export const STORY_CT01_E = defineStory({
	id: "CT-01-e",
	title: "Session switch during stream",
	contracts: [CT_01, CT_02],
	covers: ["session-switch-during-stream"],
});

export const STORY_CT01_F = defineStory({
	id: "CT-01-f",
	title: "Page reload during stream",
	contracts: [CT_01, CT_05],
	covers: ["page-reload"],
});

// ── Focus Follows Intent stories (CT-06) ──

export const STORY_CT06_A = defineStory({
	id: "CT-06-a",
	title: "Focus follows rapid session switch",
	contracts: [CT_06],
	covers: ["rapid-session-switch"],
});

export const STORY_CT06_B = defineStory({
	id: "CT-06-b",
	title: "Focus returns after dialog close",
	contracts: [CT_06],
	covers: ["dialog-close"],
});

// ── Sidebar stories (CT-03, CT-04) ──

export const STORY_SB01 = defineStory({
	id: "SB-01",
	title: "Project sections collapse and persist across reload",
	contracts: [CT_03],
	covers: ["page-reload"],
});

export const STORY_SB02 = defineStory({
	id: "SB-02",
	title: "Goal team nesting with expand and collapse",
	contracts: [CT_03],
	covers: ["collapsed-tree-expansion"],
});

export const STORY_SB03 = defineStory({
	id: "SB-03",
	title: "Auto-expand parent goal group on deep link navigation",
	contracts: [CT_03],
	covers: ["deep-link-navigation", "collapsed-tree-expansion"],
});

export const STORY_SB06 = defineStory({
	id: "SB-06",
	title: "Idle time display on session rows persists across reload",
	contracts: [CT_04],
	covers: ["page-reload"],
});

export const STORY_SB09 = defineStory({
	id: "SB-09",
	title: "Goal gate progress badge persists across reload",
	contracts: [CT_04],
	covers: ["page-reload"],
});

export const STORY_SB12 = defineStory({
	id: "SB-12",
	title: "Completed goal renders appropriately in sidebar",
	contracts: [CT_04],
	covers: ["page-reload"],
});

export const STORY_SB24 = defineStory({
	id: "SB-24",
	title: "Filter sidebar sessions by typing in search",
	contracts: [CT_03],
	covers: ["page-reload"],
});

export const STORY_SB27 = defineStory({
	id: "SB-27",
	title: "Show archived toggle reveals archived section",
	contracts: [CT_03, CT_04],
	covers: ["page-reload"],
});

export const STORY_SB32 = defineStory({
	id: "SB-32",
	title: "Sidebar collapses to icon-only mode and persists",
	contracts: [CT_03],
	covers: ["page-reload"],
});

export const STORY_SB34 = defineStory({
	id: "SB-34",
	title: "Keyboard shortcuts for sidebar search and collapse",
	contracts: [CT_03],
	covers: ["deep-link-navigation"],
});

export const STORY_CT03_HIGHLIGHT = defineStory({
	id: "CT-03-sidebar-highlight",
	title: "Session highlight follows navigation with back/forward",
	contracts: [CT_03],
	covers: ["deep-link-navigation", "back-forward-navigation"],
});

// ── Navigation stories (CT-13) ──

export const STORY_N01 = defineStory({
	id: "N-01",
	title: "Sidebar session selection updates URL and highlight",
	contracts: [CT_13, CT_03],
	covers: ["view-transitions", "page-reload", "deep-link-navigation"],
});

export const STORY_N02 = defineStory({
	id: "N-02",
	title: "Goal dashboard navigation and back",
	contracts: [CT_13],
	covers: ["back-forward-navigation"],
});

export const STORY_N03 = defineStory({
	id: "N-03",
	title: "Deep links to all view types",
	contracts: [CT_13],
	covers: ["bookmarks"],
});

export const STORY_N04 = defineStory({
	id: "N-04",
	title: "Browser back and forward across views",
	contracts: [CT_13],
	covers: ["back-forward-navigation"],
});

export const STORY_N06 = defineStory({
	id: "N-06",
	title: "Sidebar collapse persistence across reload",
	contracts: [CT_13],
	covers: ["page-reload"],
});

export const STORY_N07 = defineStory({
	id: "N-07",
	title: "Page title contains Bobbit",
	contracts: [CT_13],
	covers: ["page-reload"],
});

export const STORY_N08 = defineStory({
	id: "N-08",
	title: "Keyboard shortcuts for navigation",
	contracts: [CT_13],
	covers: ["view-transitions"],
});

export const STORY_N09 = defineStory({
	id: "N-09",
	title: "Cross-feature navigation journey",
	contracts: [CT_13],
	covers: ["view-transitions", "back-forward-navigation"],
});

export const STORY_N10 = defineStory({
	id: "N-10",
	title: "Settings sub-navigation",
	contracts: [CT_13],
	covers: ["view-transitions", "bookmarks"],
});

// ── CT-04 additional coverage ──

export const STORY_SB_CONCURRENT = defineStory({
	id: "SB-concurrent-agents",
	title: "Sidebar reflects multiple concurrent sessions",
	contracts: [CT_04],
	covers: ["concurrent-agents"],
});

// ── Session lifecycle stories (CT-05, CT-16) ──

export const STORY_S01 = defineStory({
	id: "S-01",
	title: "New session shows empty chat with focused editor",
	contracts: [CT_05, CT_16],
	covers: ["browser-refresh", "page-reload"],
});

export const STORY_S02 = defineStory({
	id: "S-02",
	title: "Sending a message produces an agent response",
	contracts: [CT_05],
	covers: ["browser-refresh"],
});

export const STORY_S03 = defineStory({
	id: "S-03",
	title: "Draft isolation across sessions",
	contracts: [CT_02, CT_05],
	covers: ["rapid-session-switch", "page-reload", "browser-refresh"],
});

export const STORY_S04 = defineStory({
	id: "S-04",
	title: "Terminated session disappears from sidebar",
	contracts: [CT_16],
	covers: ["page-reload"],
});

export const STORY_S05 = defineStory({
	id: "S-05",
	title: "Messages stay isolated between sessions",
	contracts: [CT_05],
	covers: ["browser-refresh"],
});

export const STORY_S06 = defineStory({
	id: "S-06",
	title: "Rapid session switching lands on correct session",
	contracts: [CT_05],
	covers: ["browser-refresh"],
});

export const STORY_S07 = defineStory({
	id: "S-07",
	title: "Session survives page reload",
	contracts: [CT_05],
	covers: ["browser-refresh"],
});

export const STORY_S08 = defineStory({
	id: "S-08",
	title: "Session in git repo gets a worktree",
	contracts: [CT_05, CT_16],
	covers: ["browser-refresh", "page-reload"],
});

export const STORY_S09 = defineStory({
	id: "S-09",
	title: "Renamed session title persists after reload",
	contracts: [CT_05],
	covers: ["browser-refresh"],
});

export const STORY_S10 = defineStory({
	id: "S-10",
	title: "Session properties persist across reload",
	contracts: [CT_05, CT_15],
	covers: ["browser-refresh"],
});

export const STORY_S11 = defineStory({
	id: "S-11",
	title: "Send message and receive agent response",
	contracts: [CT_01],
	covers: ["abort-mid-stream"],
});

export const STORY_S12 = defineStory({
	id: "S-12",
	title: "Sequential messages are handled correctly",
	contracts: [CT_01, CT_02],
	covers: ["rapid-sends-while-streaming"],
});

// ── Resilience stories (CT-05) ──

export const STORY_RE01 = defineStory({
	id: "RE-01",
	title: "Single session survives server crash",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

export const STORY_RE02 = defineStory({
	id: "RE-02",
	title: "Goal and dashboard survive server crash",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

export const STORY_RE03 = defineStory({
	id: "RE-03",
	title: "Multiple session types survive restart",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

export const STORY_RE04 = defineStory({
	id: "RE-04",
	title: "Worktree preservation across crash",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

export const STORY_RE05 = defineStory({
	id: "RE-05",
	title: "Docker sandbox container recovery",
	contracts: [CT_05, CT_17],
	covers: ["server-crash-restart"],
});

export const STORY_RE06 = defineStory({
	id: "RE-06",
	title: "Crash during session setup",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

export const STORY_RE07 = defineStory({
	id: "RE-07",
	title: "State survives disconnect and reload",
	contracts: [CT_05],
	covers: ["network-reconnect"],
});

export const STORY_RE08 = defineStory({
	id: "RE-08",
	title: "Rapid crash-restart cycle stability",
	contracts: [CT_05],
	covers: ["server-crash-restart"],
});

// ── Project stories (CT-16) ──

export const STORY_PR01 = defineStory({
	id: "PR-01",
	title: "Default project visible in sidebar after reload",
	contracts: [CT_16],
	covers: ["page-reload"],
});

export const STORY_PR04 = defineStory({
	id: "PR-04",
	title: "Project removal API returns proper status",
	contracts: [CT_16],
	covers: ["page-reload"],
});

export const STORY_PR09 = defineStory({
	id: "PR-09",
	title: "Sessions grouped under project survive reload",
	contracts: [CT_16],
	covers: ["page-reload", "server-restart"],
});

export const STORY_PR10 = defineStory({
	id: "PR-10",
	title: "Session created and deleted within project",
	contracts: [CT_16],
	covers: ["page-reload"],
});

// ── Goal routing stories (CT-18, CT-19) ──

export const STORY_GR01 = defineStory({
	id: "GR-01",
	title: "Per-project sidebar button creates goal in that project",
	contracts: [CT_18, CT_16],
	covers: ["per-project-button"],
});

export const STORY_GR02 = defineStory({
	id: "GR-02",
	title: "Toolbar + New Goal opens picker, creating in picked project",
	contracts: [CT_18],
	covers: ["popover-pick"],
});

export const STORY_GR03 = defineStory({
	id: "GR-03",
	title: "Back-to-back: pick A then pick B",
	contracts: [CT_18],
	covers: ["back-to-back"],
});

export const STORY_GR04 = defineStory({
	id: "GR-04",
	title: "Goal-assistant flow lands in picked project",
	contracts: [CT_18],
	covers: ["assistant-flow"],
});

export const STORY_GR05 = defineStory({
	id: "GR-05",
	title: "Reload mid-proposal preserves project",
	contracts: [CT_18, CT_05],
	covers: ["reload-mid-proposal", "page-reload"],
});

export const STORY_GR06 = defineStory({
	id: "GR-06",
	title: "API: cwd-only request resolves project",
	contracts: [CT_18],
	covers: ["cwd-only-api"],
});

export const STORY_GR07 = defineStory({
	id: "GR-07",
	title: "API: no projectId + no matching cwd returns 400",
	contracts: [CT_18],
	covers: ["missing-project-400-goal"],
});

export const STORY_GR08 = defineStory({
	id: "GR-08",
	title: "API: session creation enforces same contract",
	contracts: [CT_18],
	covers: ["missing-project-400-session"],
});

export const STORY_GR09 = defineStory({
	id: "GR-09",
	title: "First-run zero-project UX disables New Goal",
	contracts: [CT_19],
	covers: ["zero-project-disabled"],
});

export const STORY_GR10 = defineStory({
	id: "GR-10",
	title: "Single-project install skips the picker",
	contracts: [CT_19],
	covers: ["single-project-shortcircuit"],
});

// ── Continue-Archived story (CT-05 / CT-16) ──

export const STORY_CA01 = defineStory({
	id: "CA-01",
	title: "Continue archived session into a new session with seeded history",
	contracts: [CT_05, CT_16],
	covers: ["page-reload"],
});
