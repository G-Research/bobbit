import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, ChevronDown, Pencil, Plus, Wrench } from "lucide";
import { fetchTools, fetchToolDetail, updateTool, fetchRoles, gatewayFetch, type ToolInfo, type RoleData } from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { renderTool } from "../ui/tools/index.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOOL_GROUPS = ["File System", "Shell", "Web", "Browser", "Agent", "Team", "Tasks", "Gates", "Other"];

/** Build a mock ToolResultMessage with the correct content array format. */
function mockResult(text: string): any {
	return { type: "tool_result", content: [{ type: "text", text }], tool_use_id: "mock" };
}

/** Sample params and results for renderer preview. */
const TOOL_MOCK_DATA: Record<string, { params: any; result: any }> = {
	// Shell
	bash: {
		params: { command: "npm run check" },
		result: mockResult("No errors found.\n"),
	},
	bash_bg: {
		params: { action: "create", command: "npm run dev" },
		result: mockResult('{"id":"bg-1","status":"running"}'),
	},
	// File System
	read: {
		params: { path: "src/app/main.ts", limit: 20 },
		result: mockResult("import { html } from 'lit';\nimport { state } from './state.js';\n// ...(18 more lines)"),
	},
	write: {
		params: { path: "src/app/example.ts", content: "export const hello = 'world';\n" },
		result: mockResult("File written: src/app/example.ts (1 line)"),
	},
	edit: {
		params: { path: "src/app/main.ts", oldText: "const x = 1;", newText: "const x = 2;" },
		result: mockResult("Successfully replaced text in src/app/main.ts."),
	},
	ls: {
		params: { path: "src/app" },
		result: mockResult("main.ts\nrender.ts\nrouting.ts\nstate.ts\napi.ts\nsidebar.ts"),
	},
	grep: {
		params: { pattern: "renderTool", path: "src/" },
		result: mockResult("src/ui/tools/index.ts:74: export function renderTool(\nsrc/app/tool-manager-page.ts:10: import { renderTool } from '../ui/tools/index.js';"),
	},
	find: {
		params: { pattern: "**/*.css", path: "src/" },
		result: mockResult("src/app/app.css\nsrc/app/role-manager.css\nsrc/app/tool-manager.css"),
	},
	// Web
	web_search: {
		params: { query: "lit html template best practices" },
		result: mockResult("1. Lit — Best Practices\n   https://lit.dev/docs/components/best-practices/\n   Guidelines for building efficient Lit components.\n\n2. Web Components Guide\n   https://developer.mozilla.org/en-US/docs/Web/API/Web_Components\n   MDN reference for Web Components APIs."),
	},
	web_fetch: {
		params: { url: "https://lit.dev/docs/" },
		result: mockResult("Lit is a simple library for building fast, lightweight web components. It provides reactive state, declarative templates, and a small footprint..."),
	},
	// Browser
	browser_navigate: {
		params: { url: "https://localhost:5173/dashboard" },
		result: mockResult("Navigated to https://localhost:5173/dashboard"),
	},
	browser_click: {
		params: { selector: "button[type='submit']" },
		result: mockResult("Clicked element matching button[type='submit']"),
	},
	browser_type: {
		params: { selector: "#username", text: "admin@example.com" },
		result: mockResult("Typed into #username"),
	},
	browser_eval: {
		params: { expression: "document.querySelectorAll('.todo-item').length" },
		result: mockResult("12"),
	},
	browser_wait: {
		params: { selector: ".dashboard-content", timeout: 5000 },
		result: mockResult("Element .dashboard-content is visible"),
	},
	browser_screenshot: {
		params: { selector: ".main-content" },
		result: mockResult("Screenshot captured"),
	},
	// Agent
	delegate: {
		params: { instructions: "Review the auth module for security issues" },
		result: mockResult("No critical issues found. 2 minor suggestions:\n1. Add rate limiting to login endpoint\n2. Use constant-time comparison for tokens"),
	},
	workflow: {
		params: { action: "status" },
		result: mockResult('{"workflow_id":"code-review","phase":"analysis","status":"in-progress","artifacts_collected":2}'),
	},
	// Team
	team_spawn: {
		params: { role: "coder", task: "Implement user authentication module" },
		result: mockResult('{"sessionId":"sess-abc123","role":"coder","status":"idle"}'),
	},
	team_list: {
		params: {},
		result: mockResult('{"agents":[{"role":"coder","status":"working","sessionId":"sess-abc123","task":"Implement auth"},{"role":"reviewer","status":"idle","sessionId":"sess-def456","task":"Awaiting code review"}]}'),
	},
	team_dismiss: {
		params: { session_id: "sess-abc123" },
		result: mockResult('{"status":"dismissed","sessionId":"sess-abc123"}'),
	},
	team_complete: {
		params: {},
		result: mockResult('{"status":"completed","agents_dismissed":3}'),
	},
	team_steer: {
		params: { session_id: "sess-abc123", message: "Focus on error handling first" },
		result: mockResult('{"status":"steered"}'),
	},
	team_prompt: {
		params: { session_id: "sess-abc123", message: "Run the test suite and fix any failures" },
		result: mockResult('{"status":"queued","position":1}'),
	},
	team_abort: {
		params: { session_id: "sess-abc123" },
		result: mockResult('{"status":"aborted"}'),
	},
	// Tasks
	task_list: {
		params: {},
		result: mockResult('{"tasks":[{"id":"task-001","title":"Implement login endpoint","type":"implementation","state":"complete"},{"id":"task-002","title":"Review auth module","type":"code-review","state":"in-progress"},{"id":"task-003","title":"Write integration tests","type":"testing","state":"todo"}]}'),
	},
	task_create: {
		params: { title: "Add rate limiting middleware", type: "implementation" },
		result: mockResult('{"id":"task-004","title":"Add rate limiting middleware","type":"implementation","state":"todo"}'),
	},
	task_update: {
		params: { task_id: "task-002abcd", state: "complete", result_summary: "No issues found" },
		result: mockResult('{"id":"task-002abcd","title":"Review auth module","type":"code-review","state":"complete"}'),
	},
	// Personalities
	personalities_list: {
		params: {},
		result: mockResult('[{"name":"thorough","description":"Extremely careful and detailed"},{"name":"fast","description":"Prioritizes speed over perfection"}]'),
	},
	personalities_create: {
		params: { name: "cautious", description: "Risk-averse, prefers safe approaches", prompt: "Always consider edge cases..." },
		result: mockResult('{"name":"cautious","description":"Risk-averse, prefers safe approaches"}'),
	},
};

function getMockData(toolName: string): { params: any; result: any } {
	return TOOL_MOCK_DATA[toolName] || {
		params: { example: "value" },
		result: mockResult("OK"),
	};
}

function renderRendererPreview(toolName: string): TemplateResult {
	const mock = getMockData(toolName);
	const inProgress = renderTool(toolName, mock.params, undefined, true);
	const complete = renderTool(toolName, mock.params, mock.result, false);
	return html`
		<div class="tools-renderer-preview">
			<div class="tools-renderer-preview-label">In progress</div>
			<div class="tools-renderer-preview-box">${inProgress.content}</div>
			<div class="tools-renderer-preview-label">Complete</div>
			<div class="tools-renderer-preview-box">${complete.content}</div>
		</div>
	`;
}

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let tools: ToolInfo[] = [];
let roles: RoleData[] = [];
let selectedTool: ToolInfo | null = null;
let loading = true;
let editDescription = "";
let editGroup = "";
let editDocs = "";
let saving = false;
let collapsedGroups = new Set<string>();

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadToolPageData(): Promise<void> {
	currentView = "list";
	selectedTool = null;
	loading = true;
	saving = false;
	renderApp();
	const [t, r] = await Promise.all([fetchTools(), fetchRoles()]);
	tools = t;
	roles = r;
	loading = false;
	renderApp();
}

export function clearToolPageState(): void {
	currentView = "list";
	selectedTool = null;
	loading = true;
	saving = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedTool = null;
	setHashRoute("tools");
}

function showEdit(tool: ToolInfo): void {
	currentView = "edit";
	selectedTool = tool;
	editDescription = tool.description;
	editGroup = tool.group;
	editDocs = tool.docs || "";
	saving = false;
	setHashRoute("tool-edit", tool.name);
}

/** Called by the main router when navigating to #/tools/:name */
export function navigateToToolEdit(toolName: string): void {
	// Try from cached list first
	const tool = tools.find((t) => t.name === toolName);
	if (tool) {
		currentView = "edit";
		selectedTool = tool;
		editDescription = tool.description;
		editGroup = tool.group;
		editDocs = tool.docs || "";
		saving = false;
		renderApp();
		// Also fetch full detail (may have docs)
		fetchToolDetail(toolName).then((detail) => {
			if (detail && selectedTool?.name === toolName) {
				selectedTool = detail;
				// Only update docs from detail if user hasn't changed it
				if (editDocs === (tool.docs || "")) {
					editDocs = detail.docs || "";
				}
				renderApp();
			}
		});
	} else {
		// Not in cache, fetch directly
		fetchToolDetail(toolName).then((detail) => {
			if (detail) {
				currentView = "edit";
				selectedTool = detail;
				editDescription = detail.description;
				editGroup = detail.group;
				editDocs = detail.docs || "";
				saving = false;
			} else {
				currentView = "list";
				selectedTool = null;
			}
			renderApp();
		});
	}
}

async function createToolAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ toolAssistant: true }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { isToolAssistant: true });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create tool assistant", msg);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	if (!selectedTool) return;
	saving = true;
	renderApp();

	const ok = await updateTool(selectedTool.name, {
		description: editDescription,
		group: editGroup,
		docs: editDocs,
	});

	if (ok) {
		// Refresh tools list and update selectedTool
		const [t] = await Promise.all([fetchTools()]);
		tools = t;
		const updated = tools.find((t) => t.name === selectedTool!.name);
		if (updated) {
			// Fetch full detail to get docs back
			const detail = await fetchToolDetail(updated.name);
			if (detail) {
				showEdit(detail);
			} else {
				showEdit(updated);
			}
		} else {
			showList();
		}
		return;
	}
	saving = false;
	renderApp();
}

function toggleGroup(group: string): void {
	if (collapsedGroups.has(group)) {
		collapsedGroups.delete(group);
	} else {
		collapsedGroups.add(group);
	}
	renderApp();
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit" && selectedTool) {
		const hasChanges = selectedTool && (
			editDescription !== selectedTool.description ||
			editGroup !== selectedTool.group ||
			editDocs !== (selectedTool.docs || "")
		);
		return html`
			<div class="tools-nav">
				<div class="tools-nav-left">
					<button class="tools-back" @click=${showList} title="Back to tools">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="tools-title-group">
						<span class="tools-breadcrumb" @click=${showList}>Tools</span>
						<span class="tools-breadcrumb-sep">/</span>
						<h1 class="tools-title">${selectedTool.name}</h1>
					</div>
				</div>
				<div class="tools-nav-right">
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || !hasChanges,
						children: saving ? "Saving\u2026" : "Save",
					})}
				</div>
			</div>
		`;
	}

	return html`
		<div class="tools-nav">
			<div class="tools-nav-left">
				<button class="tools-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="tools-title">Tools</h1>
			</div>
			<div class="tools-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: createToolAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Tool</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderToolRow(tool: ToolInfo): TemplateResult {
	return html`
		<div class="tool-row" tabindex="0" role="button"
			@click=${() => showEdit(tool)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(tool); } }}>
			<span class="tool-row-name">${tool.name}</span>
			<span class="tool-row-desc">${tool.description}</span>
			<div class="tool-row-actions">
				<button class="tool-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(tool); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="tools-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading tools\u2026</span>
			</div>
		`;
	}

	if (tools.length === 0) {
		return html`
			<div class="tools-empty">
				<p class="tools-empty-title">No tools found</p>
				<p class="tools-empty-desc">Tools are registered by the agent runtime and appear here automatically.</p>
			</div>
		`;
	}

	// Group tools
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const g = tool.group || "Other";
		const list = groups.get(g) || [];
		list.push(tool);
		groups.set(g, list);
	}

	// Sort groups by TOOL_GROUPS order
	const sortedGroups = TOOL_GROUPS.filter((g) => groups.has(g));
	// Add any groups not in TOOL_GROUPS
	for (const g of groups.keys()) {
		if (!sortedGroups.includes(g)) sortedGroups.push(g);
	}

	const chevronSvg = html`<svg class="tool-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

	return html`
		<p class="text-sm text-muted-foreground mb-3">Tools are the capabilities available to agents \u2014 file editing, shell commands, web search, and more. This page lets you view and document them.</p>
		<div class="tools-list">
			${sortedGroups.map((groupName) => {
				const groupTools = groups.get(groupName)!;
				const isCollapsed = collapsedGroups.has(groupName);
				return html`
					<div class="tool-group ${isCollapsed ? "collapsed" : ""}">
						<button class="tool-group-header" @click=${() => toggleGroup(groupName)}>
							${chevronSvg}
							<span class="tool-group-name">${groupName}</span>
							<span class="tool-group-count">${groupTools.length} tool${groupTools.length !== 1 ? "s" : ""}</span>
						</button>
						<div class="tool-group-items">
							${groupTools.map((tool) => renderToolRow(tool))}
						</div>
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	if (!selectedTool) return html``;

	// Determine role access for this tool (including General)
	const roleAccess = roles.map((role) => {
		const allowed = role.allowedTools.includes(selectedTool!.name);
		return { role, allowed };
	});

	return html`
		<div class="tools-edit">
			<!-- Left panel -->
			<div class="tools-edit-main">
				<div class="tools-section">
					<h2 class="tools-section-title">Identity</h2>
					<div class="tools-identity-row">
						<div class="tools-field">
							<label class="tools-field-label">Name</label>
							<div class="tools-field-readonly">${selectedTool.name}</div>
						</div>
						<div class="tools-field" style="flex:1;min-width:0">
							<label class="tools-field-label">Description</label>
							${Input({
								value: editDescription,
								placeholder: "Short description of what this tool does",
								onInput: (e: Event) => { editDescription = (e.target as HTMLInputElement).value; renderApp(); },
							})}
						</div>
					</div>
					<div class="tools-field">
						<label class="tools-field-label">Group</label>
						<select class="tools-select"
							.value=${editGroup}
							@change=${(e: Event) => { editGroup = (e.target as HTMLSelectElement).value; renderApp(); }}>
							${TOOL_GROUPS.map((g) => html`<option value=${g} ?selected=${editGroup === g}>${g}</option>`)}
						</select>
					</div>
				</div>
				<div class="tools-section">
					<h2 class="tools-section-title">Documentation</h2>
					<p class="tools-note">Markdown documentation — usage examples, parameter descriptions, expected output.</p>
					<textarea
						class="tools-docs-editor"
						.value=${editDocs}
						placeholder="Write documentation for this tool..."
						@input=${(e: Event) => { editDocs = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>
			</div>

			<!-- Right sidebar -->
			<div class="tools-sidebar">
				<!-- Renderer info -->
				<div class="tools-section">
					<h2 class="tools-section-title">Renderer</h2>
					<div class="tools-renderer-card">
						<div class="tools-renderer-status">
							<span class="tools-renderer-dot ${selectedTool.hasRenderer ? "tools-renderer-dot--custom" : "tools-renderer-dot--default"}"></span>
							<span class="tools-renderer-label">${selectedTool.hasRenderer ? "Custom renderer" : "Default renderer"}</span>
						</div>
						${selectedTool.rendererFile
							? html`<span class="tools-renderer-path">${selectedTool.rendererFile}</span>`
							: nothing}
					</div>
					${renderRendererPreview(selectedTool.name)}
				</div>

				<!-- Role access -->
				<div class="tools-section">
					<h2 class="tools-section-title">Role Access</h2>
					<p class="tools-note">Which roles can use this tool.</p>
					${roleAccess.length > 0 ? html`
						<div class="tools-role-list">
							${roleAccess.map(({ role, allowed }) => html`
								<div class="tools-role-row"
									@click=${() => setHashRoute("role-edit", role.name)}>
									<span class="tools-role-name">${role.label}</span>
									<span class="tools-role-badge ${allowed ? "tools-role-badge--allowed" : "tools-role-badge--restricted"}">
										${allowed ? "Allowed" : "Restricted"}
									</span>
								</div>
							`)}
						</div>
					` : html`<p class="tools-note">No roles defined yet.</p>`}
				</div>

				<!-- Tool Assistant shortcut -->
				<div class="tools-section">
					<h2 class="tools-section-title">Actions</h2>
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: createToolAssistantSession,
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Wrench, "sm")} Open Tool Assistant</span>`,
					})}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderToolManagerPage(): TemplateResult {
	return html`
		<div class="tools-container">
			${renderNavBar()}
			<div class="tools-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
