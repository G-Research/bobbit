import type { ToolResultMessage } from "@mariozechner/pi-ai";
import "./javascript-repl.js"; // Auto-registers the renderer
import "./extract-document.js"; // Auto-registers the renderer
import { getToolRenderer, registerToolRenderer } from "./renderer-registry.js";
import { BashRenderer } from "./renderers/BashRenderer.js";
import { BrowserClickRenderer } from "./renderers/BrowserClickRenderer.js";
import { BrowserEvalRenderer } from "./renderers/BrowserEvalRenderer.js";
import { BrowserNavigateRenderer } from "./renderers/BrowserNavigateRenderer.js";
import { BrowserTypeRenderer } from "./renderers/BrowserTypeRenderer.js";
import { BrowserWaitRenderer } from "./renderers/BrowserWaitRenderer.js";
import { DefaultRenderer } from "./renderers/DefaultRenderer.js";
import { DelegateRenderer } from "./renderers/DelegateRenderer.js";
import { EditRenderer } from "./renderers/EditRenderer.js";
import { FindRenderer } from "./renderers/FindRenderer.js";
import { GrepRenderer } from "./renderers/GrepRenderer.js";
import { LsRenderer } from "./renderers/LsRenderer.js";
import { ReadRenderer } from "./renderers/ReadRenderer.js";
import { ScreenshotRenderer } from "./renderers/ScreenshotRenderer.js";
import { WebFetchRenderer } from "./renderers/WebFetchRenderer.js";
import { WebSearchRenderer } from "./renderers/WebSearchRenderer.js";
import { WriteRenderer } from "./renderers/WriteRenderer.js";
import { TeamSpawnRenderer, TeamListRenderer, TeamDismissRenderer, TeamCompleteRenderer, TeamSteerRenderer, TeamPromptRenderer, TeamAbortRenderer } from "./renderers/TeamToolRenderers.js";
import { TaskListRenderer, TaskCreateRenderer, TaskUpdateRenderer } from "./renderers/TaskToolRenderers.js";
import { GateListRenderer, GateSignalRenderer, GateStatusRenderer } from "./renderers/GateToolRenderers.js";
import { BgProcessRenderer } from "./renderers/BgProcessRenderer.js";
import { PersonalitiesListRenderer, PersonalitiesCreateRenderer } from "./renderers/PersonalityToolRenderers.js";
import type { ToolRenderResult } from "./types.js";

// Register all built-in tool renderers
registerToolRenderer("bash", new BashRenderer());
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
registerToolRenderer("delegate", new DelegateRenderer());

// Team lead coordination tools
registerToolRenderer("team_spawn", new TeamSpawnRenderer());
registerToolRenderer("team_list", new TeamListRenderer());
registerToolRenderer("team_dismiss", new TeamDismissRenderer());
registerToolRenderer("team_complete", new TeamCompleteRenderer());
registerToolRenderer("team_steer", new TeamSteerRenderer());
registerToolRenderer("team_prompt", new TeamPromptRenderer());
registerToolRenderer("team_abort", new TeamAbortRenderer());
registerToolRenderer("task_list", new TaskListRenderer());
registerToolRenderer("task_create", new TaskCreateRenderer());
registerToolRenderer("task_update", new TaskUpdateRenderer());
registerToolRenderer("bash_bg", new BgProcessRenderer());
registerToolRenderer("personalities_list", new PersonalitiesListRenderer());
registerToolRenderer("personalities_create", new PersonalitiesCreateRenderer());
registerToolRenderer("gate_list", new GateListRenderer());
registerToolRenderer("gate_signal", new GateSignalRenderer());
registerToolRenderer("gate_status", new GateStatusRenderer());

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
): ToolRenderResult {
	// If showJsonMode is enabled, always use the default renderer
	if (showJsonMode) {
		return defaultRenderer.render(params, result, isStreaming);
	}

	const renderer = getToolRenderer(toolName);
	if (renderer) {
		return renderer.render(params, result, isStreaming);
	}
	return defaultRenderer.withToolName(toolName).render(params, result, isStreaming);
}

export { getToolRenderer, registerToolRenderer };
