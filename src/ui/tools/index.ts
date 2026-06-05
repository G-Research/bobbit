import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { getToolRenderer, registerToolRenderer, registerLazyToolRenderer } from "./renderer-registry.js";
// Eagerly registered renderers — these appear on virtually every cold
// session view (the common shell/filesystem tools every agent uses) and
// are tiny (~1–5 kB each). Heavier or rarer renderers below are lazy.
import { BashRenderer } from "./renderers/BashRenderer.js";
import { BrowserClickRenderer } from "./renderers/BrowserClickRenderer.js";
import { BrowserEvalRenderer } from "./renderers/BrowserEvalRenderer.js";
import { BrowserNavigateRenderer } from "./renderers/BrowserNavigateRenderer.js";
import { BrowserTypeRenderer } from "./renderers/BrowserTypeRenderer.js";
import { BrowserWaitRenderer } from "./renderers/BrowserWaitRenderer.js";
import { DefaultRenderer } from "./renderers/DefaultRenderer.js";
import { EditRenderer } from "./renderers/EditRenderer.js";
import { FindRenderer } from "./renderers/FindRenderer.js";
import { GrepRenderer } from "./renderers/GrepRenderer.js";
import { LsRenderer } from "./renderers/LsRenderer.js";
import { ReadRenderer } from "./renderers/ReadRenderer.js";
import { ScreenshotRenderer } from "./renderers/ScreenshotRenderer.js";
import { WebFetchRenderer } from "./renderers/WebFetchRenderer.js";
import { WebSearchRenderer } from "./renderers/WebSearchRenderer.js";
import { WriteRenderer } from "./renderers/WriteRenderer.js";
// Eagerly-registered PR renderers (LSP + nested-goal children). The Team /
// Task / Gate / Inbox / Review / Proposal / compaction renderers are loaded
// lazily below (master's bundle-size work) so they need no static import here.
import { GoalSpawnChildRenderer } from "./renderers/GoalSpawnChildRenderer.js";
import { GoalPlanProposeRenderer } from "./renderers/GoalPlanProposeRenderer.js";
import { GoalPlanStatusRenderer } from "./renderers/GoalPlanStatusRenderer.js";
import { GoalMergeChildRenderer } from "./renderers/GoalMergeChildRenderer.js";
import { GoalPauseRenderer, GoalResumeRenderer } from "./renderers/GoalPauseResumeRenderer.js";
import { GoalArchiveChildRenderer } from "./renderers/GoalArchiveChildRenderer.js";
import { GoalDecideMutationRenderer } from "./renderers/GoalDecideMutationRenderer.js";
import { GoalSetPolicyRenderer } from "./renderers/GoalSetPolicyRenderer.js";
import { LspDefinitionRenderer } from "./renderers/LspDefinitionRenderer.js";
import { LspReferencesRenderer } from "./renderers/LspReferencesRenderer.js";
import { LspDiagnosticsRenderer } from "./renderers/LspDiagnosticsRenderer.js";
import { LspDocumentSymbolsRenderer } from "./renderers/LspDocumentSymbolsRenderer.js";
import { LspWorkspaceSymbolRenderer } from "./renderers/LspWorkspaceSymbolRenderer.js";
import { LspRenameRenderer } from "./renderers/LspRenameRenderer.js";
import type { ToolRenderContext, ToolRenderResult } from "./types.js";

// Register all built-in tool renderers
registerToolRenderer("bash", new BashRenderer());
registerToolRenderer("readonly_bash", new BashRenderer());
registerToolRenderer("read", new ReadRenderer());
registerToolRenderer("write", new WriteRenderer());
registerToolRenderer("edit", new EditRenderer());
registerToolRenderer("ls", new LsRenderer());
registerToolRenderer("find", new FindRenderer());
registerToolRenderer("grep", new GrepRenderer());
registerToolRenderer("browser_screenshot", new ScreenshotRenderer());
registerToolRenderer("browser_navigate", new BrowserNavigateRenderer());
registerToolRenderer("browser_click", new BrowserClickRenderer());
registerToolRenderer("browser_type", new BrowserTypeRenderer());
registerToolRenderer("browser_eval", new BrowserEvalRenderer());
registerToolRenderer("browser_wait", new BrowserWaitRenderer());
registerToolRenderer("web_search", new WebSearchRenderer());
registerToolRenderer("web_fetch", new WebFetchRenderer());
// Synthetic UI-only tool — emitted by the client on compaction_end. Never
// registered as an LLM-facing tool, so no tool-description-budget impact.
// Lazy because compaction is a once-per-session event and the renderer
// pulls `delegate-cards.ts` (3.2 kB) into the entry chunk otherwise.
registerLazyToolRenderer("__compaction_summary", async () => {
	const { CompactionSummaryRenderer } = await import("./renderers/CompactionSummaryRenderer.js");
	return new CompactionSummaryRenderer();
});

// ── Lazy renderers — share one chunk per source file via dynamic import.
// Each tool slot resolves through `import(...)` so all `team_*` slots land
// in the same `TeamToolRenderers` chunk; the registry shows a placeholder
// card until the chunk loads, then re-renders. Keeps these ~40 kB of
// secondary-flow renderer code out of the entry bundle (the average chat
// session never sees most of them in the first 30 seconds).
//
// To add a new tool, follow the existing pattern: one
// `registerLazyToolRenderer` call per tool name, all reaching the same
// `import("./renderers/<File>.js")`. Vite groups them automatically.
function registerLazyClass<M, K extends keyof M>(toolName: string, loader: () => Promise<M>, exportName: K) {
	registerLazyToolRenderer(toolName, async () => {
		const mod = await loader();
		const Cls = mod[exportName] as unknown as new () => import("./types.js").ToolRenderer;
		return new Cls();
	});
}

const loadTeamRenderers = () => import("./renderers/TeamToolRenderers.js");
registerLazyClass("team_spawn", loadTeamRenderers, "TeamSpawnRenderer");
registerLazyClass("team_list", loadTeamRenderers, "TeamListRenderer");
registerLazyClass("team_dismiss", loadTeamRenderers, "TeamDismissRenderer");
registerLazyClass("team_complete", loadTeamRenderers, "TeamCompleteRenderer");
registerLazyClass("team_steer", loadTeamRenderers, "TeamSteerRenderer");
registerLazyClass("team_prompt", loadTeamRenderers, "TeamPromptRenderer");
registerLazyClass("team_abort", loadTeamRenderers, "TeamAbortRenderer");

const loadTaskRenderers = () => import("./renderers/TaskToolRenderers.js");
registerLazyClass("task_list", loadTaskRenderers, "TaskListRenderer");
registerLazyClass("task_create", loadTaskRenderers, "TaskCreateRenderer");
registerLazyClass("task_update", loadTaskRenderers, "TaskUpdateRenderer");

const loadGateRenderers = () => import("./renderers/GateToolRenderers.js");
registerLazyClass("gate_list", loadGateRenderers, "GateListRenderer");
registerLazyClass("gate_signal", loadGateRenderers, "GateSignalRenderer");
registerLazyClass("gate_status", loadGateRenderers, "GateStatusRenderer");

const loadInboxRenderers = () => import("./renderers/InboxToolRenderers.js");
registerLazyClass("inbox_list", loadInboxRenderers, "InboxListRenderer");
registerLazyClass("inbox_complete", loadInboxRenderers, "InboxCompleteRenderer");
registerLazyClass("inbox_dismiss", loadInboxRenderers, "InboxDismissRenderer");

const loadReviewRenderers = () => import("./renderers/ReviewRenderer.js");
registerLazyClass("review_open", loadReviewRenderers, "ReviewOpenRenderer");
registerLazyClass("review_close", loadReviewRenderers, "ReviewCloseRenderer");

registerLazyToolRenderer("bash_bg", async () => {
	const { BgProcessRenderer } = await import("./renderers/BgProcessRenderer.js");
	return new BgProcessRenderer();
});
registerLazyToolRenderer("delegate", async () => {
	const { DelegateRenderer } = await import("./renderers/DelegateRenderer.js");
	return new DelegateRenderer();
});
registerLazyToolRenderer("ask_user_choices", async () => {
	const { AskUserChoicesRenderer } = await import("./renderers/AskUserChoicesRenderer.js");
	return new AskUserChoicesRenderer();
});
registerLazyToolRenderer("activate_skill", async () => {
	const { ActivateSkillRenderer } = await import("./renderers/ActivateSkillRenderer.js");
	return new ActivateSkillRenderer();
});
registerLazyToolRenderer("edit_proposal", async () => {
	const { EditProposalRenderer } = await import("./renderers/EditProposalRenderer.js");
	return new EditProposalRenderer();
});

// LSP tool renderers — all eager except hover, which transitively pulls
// the heavy `<markdown-block>` element graph (KaTeX/marked/highlight.js).
registerToolRenderer("lsp_definition", new LspDefinitionRenderer());
registerToolRenderer("lsp_references", new LspReferencesRenderer());
registerToolRenderer("lsp_diagnostics", new LspDiagnosticsRenderer());
registerToolRenderer("lsp_document_symbols", new LspDocumentSymbolsRenderer());
registerToolRenderer("lsp_workspace_symbol", new LspWorkspaceSymbolRenderer());
registerToolRenderer("lsp_rename", new LspRenameRenderer());
registerLazyToolRenderer("lsp_hover", async () => {
	const { LspHoverRenderer } = await import("./renderers/LspHoverRenderer.js");
	return new LspHoverRenderer();
});

// ── Heavy renderers — lazy-loaded on first encounter of each tool. ──
// These pull MarkdownBlock/KaTeX/pdfjs/docx-preview transitively, so keeping
// them out of the main chunk is the whole point.
registerLazyToolRenderer("gate_inspect", async () => {
	const { GateInspectRenderer } = await import("./renderers/GateInspectRenderer.js");
	return new GateInspectRenderer();
});
registerLazyToolRenderer("verification_result", async () => {
	const { VerificationResultRenderer } = await import("./renderers/VerificationResultRenderer.js");
	return new VerificationResultRenderer();
});
registerLazyToolRenderer("preview_open", async () => {
	const { PreviewOpenRenderer } = await import("./renderers/PreviewRenderer.js");
	return new PreviewOpenRenderer();
});
registerLazyToolRenderer("extract_document", async () => {
	const { extractDocumentRenderer } = await import("./extract-document.js");
	return extractDocumentRenderer;
});
registerLazyToolRenderer("javascript_repl", async () => {
	const { javascriptReplRenderer } = await import("./javascript-repl.js");
	return javascriptReplRenderer;
});
registerLazyToolRenderer("read_session", async () => {
	const { ReadSessionRenderer } = await import("./renderers/ReadSessionRenderer.js");
	return new ReadSessionRenderer();
});
// gate_verification_live custom element is loaded lazily via
// `src/ui/lazy/gate-verification-live.ts` from GateToolRenderers.

// Proposal tools — one renderer per proposal type, all sharing the same
// lazy `ProposalRenderer` chunk via deduped `import()`.
const PROPOSAL_TOOL_NAMES = [
	"propose_goal", "propose_role", "propose_tool",
	"propose_staff", "propose_project",
] as const;
for (const name of PROPOSAL_TOOL_NAMES) {
	registerLazyToolRenderer(name, async () => {
		const { ProposalRenderer } = await import("./renderers/ProposalRenderer.js");
		return new ProposalRenderer(name);
	});
}

// Children (nested-goal) tools — each renderer internally checks
// isSubgoalsEnabled() and falls through to DefaultRenderer when off.
registerToolRenderer("goal_spawn_child", new GoalSpawnChildRenderer());
registerToolRenderer("goal_plan_propose", new GoalPlanProposeRenderer());
registerToolRenderer("goal_plan_status", new GoalPlanStatusRenderer());
registerToolRenderer("goal_merge_child", new GoalMergeChildRenderer());
registerToolRenderer("goal_pause", new GoalPauseRenderer());
registerToolRenderer("goal_resume", new GoalResumeRenderer());
registerToolRenderer("goal_archive_child", new GoalArchiveChildRenderer());
registerToolRenderer("goal_decide_mutation", new GoalDecideMutationRenderer());
registerToolRenderer("goal_set_policy", new GoalSetPolicyRenderer());

const defaultRenderer = new DefaultRenderer();

// Global flag to force default JSON rendering for all tools
let showJsonMode = false;

/**
 * Enable or disable show JSON mode
 * When enabled, all tool renderers will use the default JSON renderer
 */
export function setShowJsonMode(enabled: boolean): void {
	showJsonMode = enabled;
}

/**
 * Render tool - unified function that handles params, result, and streaming state
 */
export function renderTool(
	toolName: string,
	params: any | undefined,
	result: ToolResultMessage | undefined,
	isStreaming?: boolean,
	ctx?: ToolRenderContext,
): ToolRenderResult {
	// If showJsonMode is enabled, always use the default renderer
	if (showJsonMode) {
		return defaultRenderer.render(params, result, isStreaming);
	}

	const renderer = getToolRenderer(toolName);
	if (renderer) {
		return renderer.render(params, result, isStreaming, ctx);
	}
	return defaultRenderer.withToolName(toolName).render(params, result, isStreaming);
}

export { getToolRenderer, registerToolRenderer };
