// CSS for this page is eagerly imported from main.ts (see comment there).
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus } from "lucide";
import { decideMcpServerApproval, fetchToolDetail, fetchToolsResponse, normalizeToolDiagnostics, updateTool, fetchRoles, updateRole, fetchGroupPolicies, updateGroupPolicy, fetchMcpServers, gatewayFetch, type ToolInfo, type RoleData, type McpApprovalDecision, type McpServerInfo, type McpOperationInfo, type McpServerRequestScope, type ToolProviderProvenance, type ToolDiagnostic } from "./api.js";
import { errorFromResponse, errorDetails } from "./error-helpers.js";
import { connectToSession } from "./session-manager.js";
import { confirmAction, showConnectionError } from "./dialogs.js";
import { state, renderApp, type GatewaySession, type Goal } from "./state.js";
import { getRouteFromHash, setHashRoute, setMcpReviewToolsRoute } from "./routing.js";
import { renderTool } from "../ui/tools/index.js";
import { type ConfigOrigin, getConfigScope, setConfigScope, getConfigApiProjectId, renderOriginBadge, isInherited, renderConfigScopeRow, customizeItem, revertOverride, getCurrentProjectName } from "./config-scope.js";
import { HEADQUARTERS_PROJECT_ID } from "./headquarters.js";
import { hasMcpOperatorCredential, pairMcpOperatorBrowser } from "./mcp-operator-auth.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOOL_GROUPS = ["File System", "Shell", "Web", "Browser", "Agent", "Team", "Tasks", "Gates", "Other"];

function isConfigOrigin(origin: unknown): origin is ConfigOrigin {
	return origin === "builtin" || origin === "server" || origin === "user" || origin === "project";
}

function isPiExtensionTool(tool: ToolInfo | null | undefined): boolean {
	if (!tool) return false;
	return tool.providerType === "pi-extension"
		|| tool.origin === "marketplace-pi-extension"
		|| (tool.providers ?? []).some((provider) => provider.providerKey?.startsWith("pi-ext:"));
}

function piProviderSummary(provider: ToolProviderProvenance): string {
	const pack = provider.packName || "unknown pack";
	const list = provider.listName ? ` / ${provider.listName}` : "";
	const scope = provider.scope ? ` (${provider.scope})` : "";
	return `${pack}${list}${scope}`;
}

function renderToolOriginBadges(tool: ToolInfo): TemplateResult | string {
	if (isPiExtensionTool(tool)) {
		const providers = tool.providers ?? [];
		const packName = tool.originPackName || providers[0]?.packName || "marketplace";
		return html`
			<span class="inline-flex items-center gap-1 shrink-0">
				<span class="tools-provider-badge tools-provider-badge--pi" data-testid="tool-pi-extension-badge" title="Pi runtime extension tool">Pi extension</span>
				<span class="config-origin-pack" data-testid="origin-pack-chip" title="From pack: ${packName}">${packName}</span>
			</span>
		`;
	}
	const origin = isConfigOrigin(tool.origin) ? tool.origin : undefined;
	const overrides = isConfigOrigin((tool as any).overrides) ? (tool as any).overrides : undefined;
	return renderOriginBadge(origin, overrides, tool.originPackName);
}

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
	// Children (nested-goal) tools
	goal_spawn_child: {
		params: { title: "Add login", planId: "plan-1", spec: "Implement the login flow." },
		result: mockResult('{"id":"g-deadbeef-1234"}'),
	},
	goal_plan_propose: {
		params: { steps: [{ phase: "do", title: "Add API", spec: "Wire endpoint" }, { phase: "verify", title: "Add tests", spec: "Pin endpoint" }] },
		result: mockResult('{"classification":"fix-up","applied":true}'),
	},
	goal_plan_status: {
		params: {},
		result: mockResult('{"steps":[{"phase":"do","title":"Add API","planId":"plan-1","childGoalId":"g-abc12345","childState":"in-progress"}],"frozen":true,"replanCount":0}'),
	},
	goal_merge_child: {
		params: { childGoalId: "g-abc12345xyz" },
		result: mockResult('{"ok":true}'),
	},
	goal_pause: {
		params: { goalId: "g-1", cascade: true },
		result: mockResult('{"count":3}'),
	},
	goal_resume: {
		params: { goalId: "g-1" },
		result: mockResult('{"count":1}'),
	},
	goal_archive_child: {
		params: { childGoalId: "g-abc12345xyz", mergedManually: true },
		result: mockResult('{"count":1}'),
	},
	goal_decide_mutation: {
		params: { decision: "approve", requestId: "req-aabbccdd" },
		result: mockResult('{"applied":true}'),
	},
	goal_set_policy: {
		params: { divergencePolicy: "balanced", maxConcurrentChildren: 3 },
		result: mockResult('{}'),
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
let toolDiagnostics: ToolDiagnostic[] = [];
let roles: RoleData[] = [];
let groupPolicies: Record<string, string> = {};
let mcpServers: McpServerInfo[] = [];
let expandedMcpServers = new Set<string>();
/** Per-tool (sub-namespace) expansion. Key: `<server>::<sub>` (`<server>::` for flat). */
let expandedMcpTools = new Set<string>();
let busyMcpServers = new Set<string>();
let mcpApprovalErrors = new Map<string, string>();
let mcpApprovalAnnouncements = new Map<string, string>();
let mcpPairingBusy = false;
let mcpPairingError: string | null = null;
let mcpPairingNotice: string | null = null;
let mcpPairingWarning: string | null = null;
let selectedTool: ToolInfo | null = null;
let loading = true;
let editDescription = "";
let editGroup = "";
let editDocs = "";
let editDetailDocs = "";
let editGrantPolicy = "";
let saving = false;
let collapsedGroups = new Set<string>();
let editTab: "access" | "context" | "renderer" = "access";
let scopedRefreshRevision = 0;
// A page/view lifetime is distinct from individual refreshes. Async actions
// capture this epoch so their UI tail cannot act on a later route or scope.
let toolPageViewEpoch = 0;
let mcpRequestScope: McpServerRequestScope = { projectId: getConfigApiProjectId() };

function requestScope(
	projectId: string,
	cwd: string | undefined,
	owner: { sessionId: string } | { goalId: string },
): McpServerRequestScope {
	return { projectId, ...owner, ...(cwd ? { cwd } : {}) };
}

function localMcpReviewOwner(): GatewaySession | Goal | undefined {
	const route = getRouteFromHash();
	if (route.view !== "tools") return undefined;
	if (route.mcpReviewSessionId) {
		return state.gatewaySessions.find((session) => session.id === route.mcpReviewSessionId)
			?? state.archivedSessions.find((session) => session.id === route.mcpReviewSessionId);
	}
	if (route.mcpReviewGoalId) return state.goals.find((goal) => goal.id === route.mcpReviewGoalId);
	return undefined;
}

async function resolveMcpRequestScope(): Promise<McpServerRequestScope> {
	const route = getRouteFromHash();
	if (route.view !== "tools" || (!route.mcpReviewSessionId && !route.mcpReviewGoalId)) {
		return { projectId: getConfigApiProjectId() };
	}
	let owner = localMcpReviewOwner();
	if (!owner) {
		const ownerPath = route.mcpReviewSessionId
			? `/api/sessions/${encodeURIComponent(route.mcpReviewSessionId)}`
			: `/api/goals/${encodeURIComponent(route.mcpReviewGoalId!)}`;
		const response = await gatewayFetch(ownerPath);
		if (response.ok) owner = await response.json() as GatewaySession | Goal;
	}
	if (owner && typeof owner.projectId === "string" && typeof owner.cwd === "string") {
		setConfigScope(owner.projectId);
		return route.mcpReviewSessionId
			? requestScope(owner.projectId, owner.cwd, { sessionId: route.mcpReviewSessionId })
			: requestScope(owner.projectId, owner.cwd, { goalId: route.mcpReviewGoalId! });
	}
	// A removed/invalid owner cannot retain path authority. Fall back to the
	// selected project's root scope and make that durable in the current route.
	setMcpReviewToolsRoute(undefined, true, true);
	return { projectId: getConfigApiProjectId() };
}

function mcpScopeKey(scope: McpServerRequestScope): string {
	return JSON.stringify([scope.projectId, scope.cwd ?? null, scope.sessionId ?? null, scope.goalId ?? null]);
}

function ownsMcpView(epoch: number, scopeKey: string): boolean {
	return epoch === toolPageViewEpoch && scopeKey === mcpScopeKey(mcpRequestScope);
}

function mcpBusyKey(serverName: string, scope: McpServerRequestScope = mcpRequestScope): string {
	return `${mcpScopeKey(scope)}\n${serverName}`;
}

// ============================================================================
// POLICY HELPERS
// ============================================================================

/** Human-readable labels for policy values */
const POLICY_LABELS: Record<string, string> = {
	"allow": "Allow",
	"ask": "Ask",
	"never": "Never",
};

interface McpPolicyKeys {
	server: string;
	package?: string;
	operation?: string;
}

function mcpPolicyKeysLocal(toolName: string): McpPolicyKeys | undefined {
	if (!toolName) return undefined;
	if (toolName.startsWith("mcp__")) {
		const parts = toolName.slice(5).split("__").filter(Boolean);
		if (parts.length === 0) return undefined;
		const server = `mcp__${parts[0]}`;
		const packageKey = parts.length >= 3 ? `${server}__${parts[1]}` : undefined;
		const operation = parts.length >= 2 ? toolName : undefined;
		return { server, package: packageKey, operation };
	}
	// Legacy MCP meta-tool names (`mcp_<server>` or `mcp_<server>__<sub>`) are
	// controls for the server/package prefix, not individual operations.
	if (toolName.startsWith("mcp_") && !toolName.startsWith("mcp__")) {
		const rest = toolName.slice(4);
		if (!rest) return undefined;
		const subSep = rest.indexOf("__");
		if (subSep === -1) {
			const server = `mcp__${rest}`;
			return { server };
		}
		const serverName = rest.slice(0, subSep);
		const sub = rest.slice(subSep + 2);
		if (!serverName || !sub) {
			const server = `mcp__${rest}`;
			return { server };
		}
		const server = `mcp__${serverName}`;
		const packageKey = `${server}__${sub}`;
		return { server, package: packageKey };
	}
	return undefined;
}

function firstPolicyMatch(keys: Array<string | undefined>, policies: Record<string, string>): { policy: string; source: string } | undefined {
	for (const key of keys) {
		if (key && policies[key]) return { policy: policies[key], source: key };
	}
	return undefined;
}

function mcpGroupPolicyDefault(toolName: string, toolGroup: string): { policy: string; source: string } {
	const mcpKeys = mcpPolicyKeysLocal(toolName);
	if (mcpKeys) {
		const mcpMatch = firstPolicyMatch([mcpKeys.operation, mcpKeys.package, mcpKeys.server, "mcp__"], groupPolicies);
		if (mcpMatch) return mcpMatch;
	}
	if (groupPolicies[toolGroup]) return { policy: groupPolicies[toolGroup], source: toolGroup };
	return { policy: "allow", source: "system default" };
}

/** Resolve effective policy for a tool using the layered resolution order. */
function resolveEffectivePolicy(toolName: string, toolGroup: string, roleToolPolicies?: Record<string, string>): string {
	const mcpKeys = mcpPolicyKeysLocal(toolName);
	if (roleToolPolicies?.[toolName]) return roleToolPolicies[toolName];
	if (roleToolPolicies) {
		if (mcpKeys) {
			const roleMcpMatch = firstPolicyMatch([
				mcpKeys.operation && mcpKeys.operation !== toolName ? mcpKeys.operation : undefined,
				mcpKeys.package,
				mcpKeys.server,
				"mcp__",
			], roleToolPolicies);
			if (roleMcpMatch) return roleMcpMatch.policy;
		}
		if (roleToolPolicies[toolGroup]) return roleToolPolicies[toolGroup];
	}

	const tool = tools.find(t => t.name === toolName);
	if (mcpKeys) {
		// Persisted/group MCP prefix policies must be authoritative over tool YAML defaults.
		const groupDefault = mcpGroupPolicyDefault(toolName, toolGroup);
		if (groupDefault.source !== "system default") return groupDefault.policy;
		if (tool?.grantPolicy) return tool.grantPolicy;
		return "allow";
	}

	if (tool?.grantPolicy) return tool.grantPolicy;
	const groupDefault = mcpGroupPolicyDefault(toolName, toolGroup);
	if (groupDefault.source !== "system default") return groupDefault.policy;
	return "allow";
}

/** Describe where a resolved policy came from. */
function policySource(toolName: string, toolGroup: string, roleToolPolicies?: Record<string, string>): string {
	const mcpKeys = mcpPolicyKeysLocal(toolName);
	if (roleToolPolicies?.[toolName]) return "tool override";
	if (roleToolPolicies) {
		if (mcpKeys) {
			const roleMcpMatch = firstPolicyMatch([
				mcpKeys.operation && mcpKeys.operation !== toolName ? mcpKeys.operation : undefined,
				mcpKeys.package,
				mcpKeys.server,
				"mcp__",
			], roleToolPolicies);
			if (roleMcpMatch) return `from ${roleMcpMatch.source} role override`;
		}
		if (roleToolPolicies[toolGroup]) return `from ${toolGroup} role override`;
	}

	const tool = tools.find(t => t.name === toolName);
	if (mcpKeys) {
		const groupDefault = mcpGroupPolicyDefault(toolName, toolGroup);
		if (groupDefault.source !== "system default") return `from ${groupDefault.source} group default`;
		if (tool?.grantPolicy) return "tool default";
		return "system default";
	}

	if (tool?.grantPolicy) return "tool default";
	const groupDefault = mcpGroupPolicyDefault(toolName, toolGroup);
	if (groupDefault.source !== "system default") return `from ${groupDefault.source} group default`;
	return "system default";
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function fetchToolsScoped(): Promise<ToolInfo[]> {
	const response = await fetchToolsResponse(getConfigApiProjectId());
	toolDiagnostics = response.diagnostics;
	return response.tools;
}

async function refreshScopedToolPageData(resetExpansion: boolean): Promise<boolean> {
	const refreshViewEpoch = toolPageViewEpoch;
	const scopedProjectId = getConfigApiProjectId();
	const scopedMcpRequest = mcpRequestScope.projectId === scopedProjectId
		? { ...mcpRequestScope }
		: { projectId: scopedProjectId };
	const scopedMcpKey = mcpScopeKey(scopedMcpRequest);
	const refreshRevision = ++scopedRefreshRevision;
	const [toolResponse, r, gp, mcp] = await Promise.all([
		fetchToolsResponse(scopedProjectId),
		fetchRoles(scopedProjectId),
		fetchGroupPolicies(scopedProjectId),
		fetchMcpServers({ ...scopedMcpRequest, ensure: true }),
	]);
	if (
		refreshViewEpoch !== toolPageViewEpoch
		|| refreshRevision !== scopedRefreshRevision
		|| scopedProjectId !== getConfigApiProjectId()
		|| scopedMcpKey !== mcpScopeKey(mcpRequestScope)
	) return false;
	tools = toolResponse.tools;
	toolDiagnostics = toolResponse.diagnostics;
	roles = r;
	groupPolicies = gp;
	mcpServers = mcp;
	if (resetExpansion) {
		expandedMcpServers = new Set();
		expandedMcpTools = new Set();
		collapsedGroups = new Set(TOOL_GROUPS);
		for (const tool of tools) collapsedGroups.add(tool.group || "Other");
	}
	return true;
}

export async function loadToolPageData(): Promise<void> {
	const loadViewEpoch = ++toolPageViewEpoch;
	const loadRevision = ++scopedRefreshRevision;
	currentView = "list";
	selectedTool = null;
	loading = true;
	saving = false;
	renderApp();
	const resolvedMcpScope = await resolveMcpRequestScope();
	if (loadViewEpoch !== toolPageViewEpoch || loadRevision !== scopedRefreshRevision) return;
	mcpRequestScope = resolvedMcpScope;
	if (await refreshScopedToolPageData(true)) {
		loading = false;
		renderApp();
	}
}

export function clearToolPageState(): void {
	toolPageViewEpoch++;
	scopedRefreshRevision++;
	mcpRequestScope = { projectId: getConfigApiProjectId() };
	currentView = "list";
	selectedTool = null;
	toolDiagnostics = [];
	mcpServers = [];
	expandedMcpServers = new Set();
	expandedMcpTools = new Set();
	busyMcpServers = new Set();
	mcpApprovalErrors = new Map();
	mcpApprovalAnnouncements = new Map();
	mcpPairingBusy = false;
	mcpPairingError = null;
	mcpPairingNotice = null;
	mcpPairingWarning = null;
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
	editDetailDocs = tool.detail_docs || "";
	editGrantPolicy = tool.grantPolicy || "";
	editTab = "access";
	saving = false;
	setHashRoute("tool-edit", tool.name);
}

/** Shared access-row template used by both default policy and role rows */
function renderAccessRow(label: string, selectValue: string, onChangeSelect: (val: string) => void, options: { value: string; label: string }[], hint?: string): TemplateResult {
	return html`
		<div class="tools-access-row">
			<span class="tools-access-row-label">${label}</span>
			<select class="tools-select tools-access-row-select"
				.value=${selectValue}
				@change=${(e: Event) => onChangeSelect((e.target as HTMLSelectElement).value)}>
				${options.map(o => html`<option value=${o.value} ?selected=${selectValue === o.value}>${o.label}</option>`)}
			</select>
			<span class="tools-access-row-hint">${hint ? html`\u2192 ${hint}` : nothing}</span>

		</div>
	`;
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
		editDetailDocs = tool.detail_docs || "";
		editGrantPolicy = tool.grantPolicy || "";
		saving = false;
		renderApp();
		// Also fetch full detail (may have docs)
		fetchToolDetail(toolName, getConfigApiProjectId()).then((detail) => {
			if (detail && selectedTool?.name === toolName) {
				selectedTool = detail;
				// Only update docs from detail if user hasn't changed it
				if (editDocs === (tool.docs || "")) {
					editDocs = detail.docs || "";
				}
				if (editDetailDocs === (tool.detail_docs || "")) {
					editDetailDocs = detail.detail_docs || "";
				}
				if (editGrantPolicy === (tool.grantPolicy || "")) {
					editGrantPolicy = detail.grantPolicy || "";
				}
				renderApp();
			}
		});
	} else {
		// Not in cache, fetch directly
		fetchToolDetail(toolName, getConfigApiProjectId()).then((detail) => {
			if (detail) {
				currentView = "edit";
				selectedTool = detail;
				editDescription = detail.description;
				editGroup = detail.group;
				editDocs = detail.docs || "";
				editDetailDocs = detail.detail_docs || "";
				editGrantPolicy = detail.grantPolicy || "";
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
		// Bind the tool-assistant session to whichever scope the Tools page is
		// currently editing. System scope is the user-facing Headquarters
		// workspace; project scope routes to that project. Either way the POST always carries a projectId so
		// the server's resolveProjectForRequest() never 400s on a missing
		// project.
		const scope = getConfigScope();
		const projectId = scope === "system" ? HEADQUARTERS_PROJECT_ID : scope;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ toolAssistant: true, projectId }),
		});
		if (!res.ok) {
			throw await errorFromResponse(res, `Session creation failed: ${res.status}`);
		}
		const { id } = await res.json();
		await connectToSession(id, false, { isToolAssistant: true });
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create tool assistant", message, { code, stack });
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

	const scopedProjectId = getConfigApiProjectId();
	const ok = await updateTool(selectedTool.name, {
		description: editDescription,
		group: editGroup,
		docs: editDocs,
		detail_docs: editDetailDocs,
		grantPolicy: editGrantPolicy || null,
	}, scopedProjectId);

	if (ok) {
		// Refresh tools list and update selectedTool
		const [t] = await Promise.all([fetchToolsScoped()]);
		tools = t;
		const updated = tools.find((t) => t.name === selectedTool!.name);
		if (updated) {
			// Fetch full detail to get docs back
			const detail = await fetchToolDetail(updated.name, getConfigApiProjectId());
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

function toggleMcpServer(name: string): void {
	if (expandedMcpServers.has(name)) {
		expandedMcpServers.delete(name);
	} else {
		expandedMcpServers.add(name);
	}
	renderApp();
}

function toggleMcpTool(server: string, sub: string | undefined): void {
	const key = `${server}::${sub ?? ""}`;
	if (expandedMcpTools.has(key)) {
		expandedMcpTools.delete(key);
	} else {
		expandedMcpTools.add(key);
	}
	renderApp();
}

/**
 * Parse an MCP bobbit name (`mcp__<server>__<op>` or
 * `mcp__<server>__<sub>__<op>`) client-side as a fallback when the server
 * payload doesn't supply `subNamespace` / `op`. Server-side single source
 * of truth is `parseMcpToolName()` in `src/server/mcp/mcp-meta.ts`.
 */
function parseMcpNameLocal(serverName: string, opInfo: McpOperationInfo): { sub?: string; op: string } {
	if (opInfo.op !== undefined) return { sub: opInfo.subNamespace, op: opInfo.op };
	const prefix = `mcp__${serverName}__`;
	const rest = opInfo.name.startsWith(prefix) ? opInfo.name.slice(prefix.length) : opInfo.name;
	const sepIdx = rest.indexOf("__");
	if (sepIdx < 0) return { op: rest };
	return { sub: rest.slice(0, sepIdx), op: rest.slice(sepIdx + 2) };
}

function stringField(record: unknown, names: string[]): string | undefined {
	const data = record && typeof record === "object" ? record as Record<string, unknown> : undefined;
	if (!data) return undefined;
	const nested = data.policyKeys && typeof data.policyKeys === "object" ? data.policyKeys as Record<string, unknown> : undefined;
	for (const name of names) {
		const value = data[name] ?? nested?.[name];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function mcpServerPolicyKey(server: McpServerInfo): string {
	const supplied = stringField(server, ["serverPolicyKey", "policyKey", "mcpPolicyKey", "server"]);
	return supplied?.startsWith("mcp__") ? supplied : `mcp__${server.name}`;
}

function mcpPackagePolicyKey(sub: string, ops: McpOperationInfo[], serverPolicyKey: string): string | undefined {
	if (!sub) return undefined;
	const supplied = stringField(ops[0], ["packagePolicyKey", "subNamespacePolicyKey", "namespacePolicyKey", "package", "subNamespace"]);
	return supplied?.startsWith("mcp__") ? supplied : `${serverPolicyKey}__${sub}`;
}

function mcpOperationPolicyKey(server: McpServerInfo, opInfo: McpOperationInfo, serverPolicyKey: string, packagePolicyKey?: string): string {
	const supplied = stringField(opInfo, ["operationPolicyKey", "fullPolicyKey", "canonicalPolicyKey", "policyKey", "toolPolicyKey", "operation"]);
	if (supplied?.startsWith("mcp__")) return supplied;
	if (opInfo.name?.startsWith("mcp__")) return opInfo.name;
	const parsed = parseMcpNameLocal(server.name, opInfo);
	const prefix = packagePolicyKey ?? serverPolicyKey;
	return `${prefix}__${parsed.op}`;
}

function inheritedMcpPolicyLabel(keys: Array<string | undefined>): string {
	const inherited = firstPolicyMatch(keys, groupPolicies);
	if (!inherited) return "Allow (default)";
	return `${POLICY_LABELS[inherited.policy] || inherited.policy} (inherited from ${inherited.source})`;
}

const MCP_APPROVAL_LABELS = {
	trusted: "Trusted",
	pending: "Pending approval",
	approved: "Approved",
	rejected: "Rejected",
	changed: "Configuration changed — review again",
} as const;

function mcpHealthLabel(server: McpServerInfo): string {
	if (server.approval?.required && (server.approval.state === "pending" || server.approval.state === "rejected" || server.approval.state === "changed")) {
		return "Not started";
	}
	if (server.status === "connecting") return "Connecting…";
	if (server.status === "connected") return "Connected";
	if (server.status === "error") return "Error";
	return "Disconnected";
}

function mcpApprovalIsInvalid(server: McpServerInfo): boolean {
	return server.diagnostics?.some((diagnostic) => diagnostic.code === "MCP_CONFIG_INVALID" || diagnostic.code === "MCP_CONFIG_PARSE_FAILED") ?? false;
}

function focusMcpReviewToggle(name: string, stillCurrent: () => boolean = () => true): void {
	requestAnimationFrame(() => {
		if (!stillCurrent()) return;
		const rows = document.querySelectorAll<HTMLElement>('[data-testid="mcp-server-row"]');
		for (const row of rows) {
			if (row.dataset.serverName === name) {
				row.querySelector<HTMLElement>('[data-testid="mcp-server-toggle"]')?.focus();
				break;
			}
		}
	});
}

function focusMcpPairingInput(stillCurrent: () => boolean = () => true): void {
	requestAnimationFrame(() => {
		if (stillCurrent()) document.querySelector<HTMLInputElement>('[data-testid="mcp-pairing-code"]')?.focus();
	});
}

function mcpPairingErrorMessage(error: unknown): string {
	const details = errorDetails(error);
	if (details.code === "MCP_OPERATOR_PAIRING_REQUIRED") {
		return "That pairing code is invalid, expired, or already used. Copy the current code from the gateway terminal and try again.";
	}
	if (details.code === "MCP_OPERATOR_PAIRING_RATE_LIMITED") {
		return "Too many pairing attempts. Wait briefly, then use the current code from the gateway terminal.";
	}
	if (details.code === "MCP_OPERATOR_PERSIST_FAILED") {
		return "The gateway could not save this browser authorization. Check the gateway terminal and try again.";
	}
	return details.message || "Could not pair this browser. Check the gateway terminal and try again.";
}

async function pairMcpBrowser(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	if (mcpPairingBusy) return;
	const form = event.currentTarget as HTMLFormElement;
	const input = form.querySelector<HTMLInputElement>('[data-testid="mcp-pairing-code"]');
	if (!input) return;
	const code = input.value;
	mcpPairingBusy = true;
	mcpPairingError = null;
	mcpPairingNotice = null;
	mcpPairingWarning = null;
	renderApp();
	try {
		const result = await pairMcpOperatorBrowser(code);
		input.value = "";
		mcpPairingNotice = "Browser paired. You can now approve or reject servers; no decision was made.";
		mcpPairingWarning = result.warning || null;
	} catch (error) {
		mcpPairingError = mcpPairingErrorMessage(error);
	} finally {
		mcpPairingBusy = false;
		renderApp();
		if (mcpPairingError) focusMcpPairingInput();
	}
}

function renderMcpPairingCallout(): TemplateResult | typeof nothing {
	const paired = hasMcpOperatorCredential();
	if (paired && !mcpPairingNotice && !mcpPairingWarning) return nothing;
	return html`
		<div class="mcp-pairing-callout" data-testid="mcp-pairing-callout">
			${!paired ? html`
				<div class="mcp-pairing-copy">Pair this browser to approve or reject project MCP servers.</div>
				<form class="mcp-pairing-form" @submit=${pairMcpBrowser}>
					<input id="mcp-pairing-code" class="mcp-pairing-input" data-testid="mcp-pairing-code" name="code" type="password" autocomplete="off" spellcheck="false" aria-label="MCP pairing code" placeholder="Gateway terminal pairing code" required ?disabled=${mcpPairingBusy}>
					<button class="mcp-pairing-button" data-testid="mcp-pair-browser" type="submit" ?disabled=${mcpPairingBusy}>${mcpPairingBusy ? "Pairing…" : "Pair browser"}</button>
				</form>
			` : nothing}
			${paired && mcpPairingNotice ? html`<div class="mcp-pairing-notice" data-testid="mcp-pairing-notice" role="status" aria-live="polite">${mcpPairingNotice}</div>` : nothing}
			${paired && mcpPairingWarning ? html`<div class="mcp-pairing-warning" data-testid="mcp-pairing-warning" role="status">${mcpPairingWarning}</div>` : nothing}
			${!paired && mcpPairingError ? html`<div class="mcp-pairing-error" data-testid="mcp-pairing-error" role="alert">${mcpPairingError}</div>` : nothing}
		</div>
	`;
}

async function decideMcpApproval(server: McpServerInfo, decision: McpApprovalDecision): Promise<void> {
	const approval = server.approval;
	const source = server.source;
	const decisionViewEpoch = toolPageViewEpoch;
	const decisionScope = { ...mcpRequestScope };
	const decisionScopeKey = mcpScopeKey(decisionScope);
	const decisionBusyKey = mcpBusyKey(server.name, decisionScope);
	const stillOwnsView = () => ownsMcpView(decisionViewEpoch, decisionScopeKey);
	if (!approval?.fingerprint || !source?.sourceId || !source.projectId || busyMcpServers.has(decisionBusyKey) || mcpApprovalIsInvalid(server)) return;
	if (decision === "rejected" && approval.state === "approved") {
		const confirmed = await confirmAction(
			`Reject ${server.name}?`,
			"Bobbit will disconnect this MCP server and remove its operations from agents. You can approve the current configuration again later.",
			"Reject server",
			true,
		);
		if (!confirmed || !stillOwnsView()) return;
	}

	busyMcpServers.add(decisionBusyKey);
	mcpApprovalErrors.delete(server.name);
	mcpApprovalAnnouncements.set(server.name, `${decision === "approved" ? "Approving" : "Rejecting"} ${server.name}…`);
	renderApp();
	let pairingRequired = false;
	try {
		await decideMcpServerApproval(server.name, {
			decision,
			fingerprint: approval.fingerprint,
			sourceProjectId: source.projectId,
			sourceId: source.sourceId,
		}, decisionScope);
		if (!stillOwnsView()) return;
		await refreshScopedToolPageData(false);
		if (!stillOwnsView()) return;
		mcpApprovalAnnouncements.set(server.name, `${server.name} ${decision === "approved" ? "approved" : "rejected"}.`);
	} catch (error) {
		if (!stillOwnsView()) return;
		const details = errorDetails(error);
		if (details.code === "MCP_APPROVAL_STALE") {
			await refreshScopedToolPageData(false);
			if (!stillOwnsView()) return;
			expandedMcpServers.add(server.name);
			mcpApprovalErrors.set(server.name, "Configuration changed while you were reviewing it. Review the current configuration before deciding.");
		} else if (details.code === "MCP_APPROVAL_HUMAN_REQUIRED") {
			pairingRequired = true;
			expandedMcpServers.add(server.name);
			mcpPairingNotice = null;
			mcpPairingWarning = null;
			mcpPairingError = "This browser is not paired with the gateway. Enter the current pairing code from the gateway terminal.";
			mcpApprovalErrors.set(server.name, "Pair this browser before approving or rejecting this server.");
		} else {
			mcpApprovalErrors.set(server.name, details.message || "Could not update server approval. Try again.");
		}
		mcpApprovalAnnouncements.set(server.name, `Approval for ${server.name} was not changed.`);
	} finally {
		busyMcpServers.delete(decisionBusyKey);
		if (stillOwnsView()) {
			renderApp();
			if (pairingRequired) focusMcpPairingInput(stillOwnsView);
			else focusMcpReviewToggle(server.name, stillOwnsView);
		}
	}
}

function renderMcpReviewValue(label: string, value: unknown): TemplateResult | typeof nothing {
	if (value === undefined || value === null || value === "") return nothing;
	return html`
		<div class="mcp-review-field">
			<dt>${label}</dt>
			<dd>${Array.isArray(value) ? value.join(" ") : String(value)}</dd>
		</div>
	`;
}

function renderMcpReviewPanel(server: McpServerInfo): TemplateResult | typeof nothing {
	const config = server.reviewConfig;
	const source = server.source;
	const approval = server.approval;
	if (!config && !source && !server.diagnostics?.length) return nothing;
	const fingerprint = approval?.fingerprint ? approval.fingerprint.slice(0, 12) : undefined;
	return html`
		<div class="mcp-review-panel" data-testid="mcp-review-panel">
			<div class="mcp-review-copy">Startup approval controls whether Bobbit may start or connect to this server. <strong>Tool calls</strong> controls whether agents may invoke its operations.</div>
			<dl class="mcp-review-grid">
				${renderMcpReviewValue("Project", source?.projectName || source?.projectId)}
				${renderMcpReviewValue("Source", source?.file)}
				${renderMcpReviewValue("Transport", config?.transport)}
				${renderMcpReviewValue("Command", config?.command)}
				${renderMcpReviewValue("Arguments", config?.args)}
				${renderMcpReviewValue("URL", config?.url)}
				${renderMcpReviewValue("Working directory", config?.cwd)}
				${renderMcpReviewValue("Environment", config?.env ? Object.entries(config.env).map(([key, value]) => `${key}=${value}`) : undefined)}
				${renderMcpReviewValue("Headers", config?.headers ? Object.entries(config.headers).map(([key, value]) => `${key}: ${value}`) : undefined)}
				${renderMcpReviewValue("Fingerprint", fingerprint)}
			</dl>
			${server.diagnostics?.length ? html`
				<div class="mcp-review-diagnostics">
					${server.diagnostics.map((diagnostic) => html`<p><code>${diagnostic.code}</code> ${diagnostic.message}</p>`)}
				</div>
			` : nothing}
		</div>
	`;
}

function renderMcpApprovalActions(server: McpServerInfo): TemplateResult | typeof nothing {
	const state = server.approval?.state;
	if (!server.approval?.required || state === "trusted" || mcpApprovalIsInvalid(server) || !server.approval.fingerprint || !server.source?.projectId) return nothing;
	const busy = busyMcpServers.has(mcpBusyKey(server.name));
	const rejectLabel = state === "approved" ? "Reject server" : "Reject";
	const approveLabel = state === "pending" ? "Approve" : "Approve current configuration";
	return html`
		<div class="mcp-approval-actions">
			${state !== "rejected" ? html`
				<button class="mcp-approval-button mcp-approval-button--reject" data-testid="mcp-reject-server" ?disabled=${busy} @click=${() => decideMcpApproval(server, "rejected")}>${busy ? "Working…" : rejectLabel}</button>
			` : nothing}
			${state !== "approved" ? html`
				<button class="mcp-approval-button mcp-approval-button--approve" data-testid="mcp-approve-server" ?disabled=${busy} @click=${() => decideMcpApproval(server, "approved")}>${busy ? "Working…" : approveLabel}</button>
			` : nothing}
		</div>
	`;
}

async function handleMcpPolicyChange(key: string, value: string): Promise<void> {
	const scopedProjectId = getConfigApiProjectId();
	await updateGroupPolicy(key, value || null, scopedProjectId);
	groupPolicies = await fetchGroupPolicies(scopedProjectId);
	renderApp();
}

function renderMcpPolicySelect(key: string, current: string, testid: string, emptyLabel = "Allow (default)"): TemplateResult {
	return html`
		<select class="tool-group-select"
			data-testid=${testid}
			data-policy-key=${key}
			.value=${current}
			@click=${(e: Event) => e.stopPropagation()}
			@keydown=${(e: KeyboardEvent) => e.stopPropagation()}
			@change=${async (e: Event) => {
				e.stopPropagation();
				const val = (e.target as HTMLSelectElement).value;
				await handleMcpPolicyChange(key, val);
			}}>
			<option value="" ?selected=${!current}>${emptyLabel}</option>
			<option value="allow" ?selected=${current === "allow"}>Allow</option>
			<option value="ask" ?selected=${current === "ask"}>Ask</option>
			<option value="never" ?selected=${current === "never"}>Never</option>
		</select>
	`;
}

function renderMcpOperationRow(tool: ToolInfo, policyKey: string, emptyPolicyLabel: string): TemplateResult {
	const origin = isConfigOrigin(tool.origin) ? tool.origin : undefined;
	const inherited = isInherited(origin);
	const currentPolicy = groupPolicies[policyKey] || "";
	return html`
		<div class="tool-row ${inherited ? "config-item-inherited" : ""}" tabindex="0" role="button"
			data-testid="mcp-operation-row" data-tool-name=${tool.name} data-policy-key=${policyKey}
			@click=${() => showEdit(tool)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(tool); } }}>
			<span class="tool-row-name">${tool.name} ${renderToolOriginBadges(tool)}</span>
			<span class="tool-row-desc">${tool.description}</span>
			<div class="tool-row-actions">
				<span class="tool-group-policy-label">Operation Policy:</span>
				${renderMcpPolicySelect(policyKey, currentPolicy, "mcp-operation-policy", emptyPolicyLabel)}
				<button class="tool-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(tool); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderMcpSection(): TemplateResult {
	if (mcpServers.length === 0) return html``;
	const chevronSvg = html`<svg class="tool-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
	const toolByName = new Map<string, ToolInfo>();
	for (const tool of tools) toolByName.set(tool.name, tool);
	const reviewCount = mcpServers.filter((server) => server.approval?.state === "pending" || server.approval?.state === "changed").length;
	return html`
		<div class="tool-group" data-testid="mcp-section">
			<div class="tool-group-header mcp-section-header">
				<span class="tool-group-name">MCP</span>
				<span class="tool-group-count">${mcpServers.length} server${mcpServers.length !== 1 ? "s" : ""}${reviewCount ? ` · ${reviewCount} need review` : ""}</span>
				<span class="mcp-section-help">Startup approval is separate from <strong>Tool calls</strong> policy.</span>
			</div>
			${mcpServers.some((server) => server.approval?.required && server.source?.authority === "project" && !mcpApprovalIsInvalid(server)) ? renderMcpPairingCallout() : nothing}
			<div class="tool-group-items">
				${mcpServers.map((server) => {
					const expanded = expandedMcpServers.has(server.name);
					const healthLabel = mcpHealthLabel(server);
					const healthText = healthLabel === "Not started" ? healthLabel : healthLabel.toLocaleLowerCase();
					const statusClass = healthLabel === "Connected" ? "text-emerald-600" : healthLabel === "Error" ? "text-red-600" : "text-muted-foreground";
					const approvalState = server.approval?.state;
					const approvalLabel = approvalState ? MCP_APPROVAL_LABELS[approvalState] : undefined;
					const serverPolicyKey = mcpServerPolicyKey(server);
					const serverPolicy = groupPolicies[serverPolicyKey] || "";
					const serverEmptyPolicyLabel = inheritedMcpPolicyLabel(["mcp__"]);
					const panelId = `mcp-review-${encodeURIComponent(server.name).replaceAll("%", "-")}`;

					const bySub = new Map<string, McpOperationInfo[]>();
					for (const op of server.tools) {
						const parsed = parseMcpNameLocal(server.name, op);
						const key = parsed.sub ?? "";
						const list = bySub.get(key) ?? [];
						list.push(op);
						bySub.set(key, list);
					}
					const subKeys = Array.from(bySub.keys()).sort();

					return html`
						<div class="mcp-server-row" data-testid="mcp-server-row" data-server-name=${server.name} data-policy-key=${serverPolicyKey}>
							<div class="mcp-server-summary">
								<button class="mcp-server-disclosure" data-testid="mcp-server-toggle" aria-expanded=${expanded ? "true" : "false"} aria-controls=${panelId} @click=${() => toggleMcpServer(server.name)}>
									<span class="mcp-server-chevron ${expanded ? "mcp-server-chevron--expanded" : ""}">${chevronSvg}</span>
									<span class="tool-group-name">${server.name}</span>
									${approvalLabel ? html`<span class="mcp-approval-status mcp-approval-status--${approvalState}" data-testid="mcp-approval-status">${approvalLabel}</span>` : nothing}
									<span class="mcp-health-status text-xs ${statusClass}" data-testid="mcp-server-status" aria-label=${healthLabel}>${healthText}</span>
									<span class="tool-group-count">${server.toolCount} operation${server.toolCount !== 1 ? "s" : ""}</span>
								</button>
								<div class="mcp-tool-call-policy">
									<span class="tool-group-policy-label">Tool calls:</span>
									${renderMcpPolicySelect(serverPolicyKey, serverPolicy, "mcp-server-policy", serverEmptyPolicyLabel)}
								</div>
								${renderMcpApprovalActions(server)}
							</div>
							<div class="mcp-approval-live" role="status" aria-live="polite" aria-atomic="true">${mcpApprovalAnnouncements.get(server.name) || nothing}</div>
							${mcpApprovalErrors.has(server.name) ? html`<div class="mcp-approval-error" data-testid="mcp-approval-error" role="alert">${mcpApprovalErrors.get(server.name)}</div>` : nothing}
							${server.status === "error" && server.error ? html`<div class="mcp-server-error" data-testid="mcp-server-error">${server.error}</div>` : nothing}
							${expanded ? html`
								<div class="mcp-server-details" id=${panelId}>
									${renderMcpReviewPanel(server)}
									<div class="tool-group-items mcp-operation-groups">
										${subKeys.length === 0 ? html`<div class="tools-note mcp-no-operations">No operations available.</div>` : subKeys.map((sub) => {
											const ops = bySub.get(sub)!;
											const hasSub = sub.length > 0;
											const packagePolicyKey = mcpPackagePolicyKey(sub, ops, serverPolicyKey);
											const packagePolicy = packagePolicyKey ? groupPolicies[packagePolicyKey] || "" : "";
											const packageEmptyPolicyLabel = inheritedMcpPolicyLabel([serverPolicyKey, "mcp__"]);
											const toolPolicyKey = packagePolicyKey ?? serverPolicyKey;
											const toolPolicy = packagePolicyKey ? packagePolicy : serverPolicy;
											const toolEmptyPolicyLabel = packagePolicyKey ? packageEmptyPolicyLabel : serverEmptyPolicyLabel;
											const toolKey = `${server.name}::${sub}`;
											const toolExpanded = expandedMcpTools.has(toolKey);
											const toolLabel = hasSub ? sub : server.name;
											return html`
												<div class="mcp-tool-row" data-testid="mcp-tool-row" data-tool-name=${toolLabel} data-policy-key=${toolPolicyKey}>
													<div class="tool-group-header" data-testid="mcp-tool-toggle" tabindex="0" role="button" @click=${() => toggleMcpTool(server.name, hasSub ? sub : undefined)} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleMcpTool(server.name, hasSub ? sub : undefined); } }}>
														<span class="mcp-server-chevron ${toolExpanded ? "mcp-server-chevron--expanded" : ""}">${chevronSvg}</span>
														<span class="tool-group-name">${toolLabel}</span>
														<span class="tool-group-count">${ops.length} operation${ops.length !== 1 ? "s" : ""}</span>
														<span class="tool-group-policy-label">${hasSub ? "Package" : "Tool"} Policy:</span>
														${renderMcpPolicySelect(toolPolicyKey, toolPolicy, "mcp-tool-policy", toolEmptyPolicyLabel)}
													</div>
													${toolExpanded ? html`<div class="mcp-server-ops" data-testid="mcp-server-ops">
														${ops.map((op) => {
															const operationPolicyKey = mcpOperationPolicyKey(server, op, serverPolicyKey, packagePolicyKey);
															const operationEmptyPolicyLabel = inheritedMcpPolicyLabel([packagePolicyKey, serverPolicyKey, "mcp__"]);
															const tool = toolByName.get(op.name) ?? { name: op.name, description: op.description, group: `MCP: ${server.name}` } as ToolInfo;
															return renderMcpOperationRow(tool, operationPolicyKey, operationEmptyPolicyLabel);
														})}
													</div>` : nothing}
												</div>
											`;
										})}
									</div>
								</div>
							` : nothing}
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit" && selectedTool) {
		const hasChanges = selectedTool && (
			editDescription !== selectedTool.description ||
			editGroup !== selectedTool.group ||
			editDocs !== (selectedTool.docs || "") ||
			editDetailDocs !== (selectedTool.detail_docs || "") ||
			editGrantPolicy !== (selectedTool.grantPolicy || "")
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
				<button
					class="text-xs text-muted-foreground hover:text-foreground transition-colors ml-2"
					@click=${() => { setHashRoute("settings", "directories"); }}
				>Manage scan directories &rarr;</button>
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

async function handleScopeChange(scope: string): Promise<void> {
	toolPageViewEpoch++;
	scopedRefreshRevision++;
	setConfigScope(scope);
	setMcpReviewToolsRoute(undefined, true, true);
	mcpRequestScope = { projectId: getConfigApiProjectId() };
	loading = true;
	mcpApprovalErrors.clear();
	mcpApprovalAnnouncements.clear();
	renderApp();
	if (await refreshScopedToolPageData(true)) {
		loading = false;
		renderApp();
	}
}

function firstDiagnosticString(diagnostic: ToolDiagnostic, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = diagnostic[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function shortDiagnosticText(text: string, max = 360): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function diagnosticMessage(diagnostic: ToolDiagnostic): string {
	const message = firstDiagnosticString(diagnostic, ["message", "reason", "invalidReason", "error", "detail", "details"]);
	if (message) return shortDiagnosticText(message);
	try {
		return shortDiagnosticText(JSON.stringify(diagnostic));
	} catch {
		return "Tool override was reported invalid.";
	}
}

function diagnosticSeverity(diagnostic: ToolDiagnostic): "error" | "warning" | "info" {
	const raw = firstDiagnosticString(diagnostic, ["severity", "level", "type"])?.toLowerCase() ?? "";
	if (raw.includes("error") || raw.includes("fail") || raw.includes("invalid")) return "error";
	if (raw.includes("info") || raw.includes("ok")) return "info";
	return "warning";
}

function diagnosticTitle(diagnostic: ToolDiagnostic): string {
	const subject = firstDiagnosticString(diagnostic, ["toolName", "tool", "name", "groupDir", "group", "providerKey"]);
	const status = firstDiagnosticString(diagnostic, ["status", "action"])?.toLowerCase() ?? "";
	const skipped = diagnostic.skipped === true || status.includes("skip");
	const label = skipped ? "Skipped tool override" : diagnosticSeverity(diagnostic) === "error" ? "Invalid tool override" : "Tool diagnostic";
	return subject ? `${label}: ${subject}` : label;
}

function toolDiagnosticEntries(tool: ToolInfo): ToolDiagnostic[] {
	const diagnostics = [
		...normalizeToolDiagnostics(tool.invalidReason),
		...normalizeToolDiagnostics(tool.diagnostics),
	];
	if ((tool.invalid === true || tool.valid === false) && diagnostics.length === 0) {
		diagnostics.push({ severity: "error", message: "This tool was reported invalid by /api/tools." });
	}
	return diagnostics;
}

function renderDiagnosticChips(diagnostic: ToolDiagnostic): TemplateResult | typeof nothing {
	const chips: Array<[string, string | undefined]> = [
		["Code", firstDiagnosticString(diagnostic, ["code", "type"])],
		["Group", firstDiagnosticString(diagnostic, ["groupDir", "group"])],
		["Tool", firstDiagnosticString(diagnostic, ["toolName", "tool", "name"])],
		["Source", firstDiagnosticString(diagnostic, ["sourcePath", "path", "file"])],
		["Fallback", firstDiagnosticString(diagnostic, ["fallbackTool", "fallbackProvider", "fallback"])],
	];
	const visible = chips.filter(([, value]) => Boolean(value));
	if (!visible.length) return nothing;
	return html`
		<div class="flex flex-wrap gap-1 mt-2">
			${visible.map(([label, value]) => html`
				<span class="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground" title=${value!}>${label}: ${shortDiagnosticText(value!, 90)}</span>
			`)}
		</div>
	`;
}

function renderToolDiagnosticsPanel(diagnostics: ToolDiagnostic[], title = "Tool diagnostics"): TemplateResult | typeof nothing {
	if (!diagnostics.length) return nothing;
	return html`
		<div class="tools-section" data-testid="tool-diagnostics" style="max-width:900px;margin:0 auto 16px;border-color:color-mix(in oklch, var(--warning) 55%, var(--border));background:color-mix(in oklch, var(--warning) 10%, transparent);">
			<h2 class="tools-section-title">${title}</h2>
			<p class="tools-note">Invalid config-level tool overrides are skipped before agent launch. Bobbit will use a lower-priority fallback when one is available.</p>
			<div class="flex flex-col gap-2 mt-3">
				${diagnostics.map((diagnostic) => {
					const severity = diagnosticSeverity(diagnostic);
					return html`
						<div data-testid="tool-diagnostic" class="rounded border border-border bg-card px-3 py-2">
							<div class="flex items-center gap-2 text-sm font-semibold">
								<span class="uppercase text-[10px] tracking-wide text-muted-foreground">${severity}</span>
								<span>${diagnosticTitle(diagnostic)}</span>
							</div>
							<div class="tools-note mt-1">${diagnosticMessage(diagnostic)}</div>
							${renderDiagnosticChips(diagnostic)}
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

function renderToolDiagnosticBadge(tool: ToolInfo): TemplateResult | typeof nothing {
	const diagnostics = toolDiagnosticEntries(tool);
	if (!diagnostics.length) return nothing;
	return html`<span class="config-readonly-note" data-testid="tool-diagnostic-badge" title=${diagnostics.map(diagnosticMessage).join("\n")}>Diagnostic</span>`;
}

function renderToolRow(tool: ToolInfo): TemplateResult {
	const origin = isConfigOrigin(tool.origin) ? tool.origin : undefined;
	const inherited = isInherited(origin);
	return html`
		<div class="tool-row ${inherited ? "config-item-inherited" : ""}" tabindex="0" role="button"
			@click=${() => showEdit(tool)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(tool); } }}>
			<span class="tool-row-name">${tool.name} ${renderToolOriginBadges(tool)} ${renderToolDiagnosticBadge(tool)}</span>
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

	const diagnosticsPanel = renderToolDiagnosticsPanel(toolDiagnostics);

	if (tools.length === 0 && mcpServers.length === 0) {
		return html`
			${diagnosticsPanel}
			<div class="tools-empty">
				<p class="tools-empty-title">No tools found</p>
				<p class="tools-empty-desc">Tools are registered by the agent runtime and appear here automatically.</p>
			</div>
		`;
	}

	// Group tools — MCP tools collapse into a dedicated section below, so exclude
	// any tool whose name follows the mcp__<server>__<op> pattern from the
	// regular per-group rendering.
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		if (tool.name.startsWith("mcp__")) continue;
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
		${diagnosticsPanel}
		<p class="text-sm text-muted-foreground mb-6" style="max-width: 700px; margin-inline: auto;">Tools are the capabilities available to agents \u2014 file editing, shell commands, web search, and more. This page lets you view and document them.</p>
		<div class="tools-list">
			${sortedGroups.map((groupName) => {
				const groupTools = groups.get(groupName)!;
				const isCollapsed = collapsedGroups.has(groupName);
				const currentGroupPolicy = groupPolicies[groupName] || "";
				return html`
					<div class="tool-group ${isCollapsed ? "collapsed" : ""}">
						<div class="tool-group-header" title="Toggle ${groupName} group" @click=${() => toggleGroup(groupName)}>
							${chevronSvg}
							<span class="tool-group-name">${groupName}</span>
							<span class="tool-group-count">${groupTools.length} tool${groupTools.length !== 1 ? "s" : ""}</span>
							<span class="tool-group-policy-label">Group Policy:</span>
							<select class="tool-group-select"
								.value=${currentGroupPolicy}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${async (e: Event) => {
									e.stopPropagation();
									const val = (e.target as HTMLSelectElement).value;
									const scopedProjectId = getConfigApiProjectId();
									await updateGroupPolicy(groupName, val || null, scopedProjectId);
									groupPolicies = await fetchGroupPolicies(scopedProjectId);
									renderApp();
								}}>
								<option value="" ?selected=${!currentGroupPolicy}>Allow (default)</option>
								<option value="allow" ?selected=${currentGroupPolicy === "allow"}>Allow</option>
								<option value="ask" ?selected=${currentGroupPolicy === "ask"}>Ask</option>
								<option value="never" ?selected=${currentGroupPolicy === "never"}>Never</option>
							</select>
						</div>
						<div class="tool-group-items">
							${groupTools.map((tool) => renderToolRow(tool))}
						</div>
					</div>
				`;
			})}
			${renderMcpSection()}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

const POLICY_OPTIONS = [
	{ value: "", label: "Use group default" },
	{ value: "allow", label: "Allow" },
	{ value: "ask", label: "Ask" },
	{ value: "never", label: "Never" },
];

const ROLE_POLICY_OPTIONS = [
	{ value: "", label: "Use default" },
	{ value: "allow", label: "Allow" },
	{ value: "ask", label: "Ask" },
	{ value: "never", label: "Never" },
];

function renderAccessTab(): TemplateResult {
	if (!selectedTool) return html``;

	const toolName = selectedTool.name;
	const toolGroup = selectedTool.group || "Other";
	const groupDefault = mcpGroupPolicyDefault(toolName, toolGroup);
	const groupDefaultLabel = POLICY_LABELS[groupDefault.policy] || groupDefault.policy;
	const groupDefaultHint = groupDefault.source === "system default"
		? `${groupDefaultLabel} [system default]`
		: `${groupDefaultLabel} [from ${groupDefault.source}]`;

	return html`
		<!-- Default Grant Policy -->
		<div class="tools-section">
			<h2 class="tools-section-title">Default Grant Policy</h2>
			<p class="tools-note">Controls what happens when an agent uses this tool without explicit role permission.</p>
			<div class="tools-access-list">
				${renderAccessRow(
					"Default",
					editGrantPolicy,
					(val) => { editGrantPolicy = val; renderApp(); },
					POLICY_OPTIONS,
					!editGrantPolicy ? groupDefaultHint : undefined,
				)}
			</div>
		</div>

		<!-- Role Access -->
		<div class="tools-section">
			<h2 class="tools-section-title">Role Access</h2>
			${roles.length > 0 ? html`
				<div class="tools-access-list">
					${roles.map((role) => {
						const rolePolicy = role.toolPolicies?.[toolName] || "";
						const effective = resolveEffectivePolicy(toolName, toolGroup, role.toolPolicies);
						const effectiveLabel = POLICY_LABELS[effective] || effective;
						const source = policySource(toolName, toolGroup, role.toolPolicies);
						return renderAccessRow(
							role.label,
							rolePolicy,
							async (val) => {
								const updated = { ...(role.toolPolicies || {}) };
								if (val) { updated[toolName] = val; } else { delete updated[toolName]; }
								const scopedProjectId = getConfigApiProjectId();
								await updateRole(role.name, { toolPolicies: Object.keys(updated).length > 0 ? updated : {} }, scopedProjectId);
								roles = await fetchRoles(scopedProjectId);
								renderApp();
							},
							ROLE_POLICY_OPTIONS,
							`${effectiveLabel} [${source}]`,
						);
					})}
				</div>
			` : html`<p class="tools-note">No roles defined yet.</p>`}
		</div>
	`;
}

function renderContextTab(): TemplateResult {
	if (!selectedTool) return html``;

	return html`
		<div class="tools-section">
			<h2 class="tools-section-title">Prompt Documentation</h2>
			<p class="tools-note">Injected into every agent's system prompt. Keep brief — critical notes and gotchas only.</p>
			<textarea
				class="tools-docs-editor"
				style="min-height:120px"
				.value=${editDocs}
				placeholder="Brief notes for the system prompt..."
				@input=${(e: Event) => { editDocs = (e.target as HTMLTextAreaElement).value; renderApp(); }}
			></textarea>
		</div>
		<div class="tools-section" style="flex:1;display:flex;flex-direction:column;">
			<h2 class="tools-section-title">Detailed Documentation</h2>
			<p class="tools-note">Full reference — examples, edge cases. Agents read on demand; NOT injected into prompts.</p>
			<textarea
				class="tools-docs-editor"
				.value=${editDetailDocs}
				placeholder="Full documentation with examples, edge cases..."
				@input=${(e: Event) => { editDetailDocs = (e.target as HTMLTextAreaElement).value; renderApp(); }}
			></textarea>
		</div>
	`;
}

function renderPiExtensionProvenance(tool: ToolInfo): TemplateResult | string {
	if (!isPiExtensionTool(tool)) return "";
	const providers = tool.providers ?? [];
	const hasCollision = providers.length > 1;
	return html`
		<div class="tools-pi-extension-card" data-testid="tool-pi-extension-provenance">
			<div class="tools-pi-extension-title">Pi extension runtime tool</div>
			<div class="tools-pi-extension-copy">This tool is registered by a standalone pi extension at session runtime. Bobbit policy is enforced by runtime tool name.</div>
			${hasCollision ? html`
				<div class="tools-pi-extension-warning" data-testid="tool-pi-extension-collision">
					Multiple providers share this runtime tool name; policy applies to all calls named <code>${tool.name}</code>.
				</div>
			` : ""}
			${providers.length ? html`
				<div class="tools-pi-extension-providers">
					${providers.map((provider) => html`
						<div class="tools-pi-extension-provider" data-testid="tool-pi-extension-provider" title=${provider.sourcePath ?? provider.providerKey}>
							<span>${piProviderSummary(provider)}</span>
							${provider.sourcePath ? html`<code>${provider.sourcePath}</code>` : ""}
						</div>
					`)}
				</div>
			` : ""}
		</div>
	`;
}

function renderRendererTab(): TemplateResult {
	if (!selectedTool) return html``;

	return html`
		<div class="tools-section">
			<div class="tools-renderer-card-inline">
				<span class="tools-renderer-dot ${selectedTool.hasRenderer ? "tools-renderer-dot--custom" : "tools-renderer-dot--default"}"></span>
				<span class="tools-renderer-label">${selectedTool.hasRenderer ? "Custom renderer" : "Default renderer"}</span>
				${selectedTool.rendererFile
					? html`<span class="tools-renderer-path" style="margin-left:auto;">${selectedTool.rendererFile}</span>`
					: nothing}
			</div>
		</div>
		<div class="tools-section">
			<h2 class="tools-section-title">Preview</h2>
			${renderRendererPreview(selectedTool.name)}
		</div>
	`;
}

function renderActiveTab(): TemplateResult {
	switch (editTab) {
		case "access": return renderAccessTab();
		case "context": return renderContextTab();
		case "renderer": return renderRendererTab();
	}
}

function renderEditView(): TemplateResult {
	if (!selectedTool) return html``;

	return html`
		<div class="tools-edit">
			<div class="tools-edit-main">
				<!-- Compact identity rows -->
				<div class="tools-identity-section">
					${selectedTool.origin || isPiExtensionTool(selectedTool) ? html`<div class="mb-1 inline-flex items-center gap-2">${renderToolOriginBadges(selectedTool)}${renderCustomizeRevertButtons()}</div>` : ""}
					${renderPiExtensionProvenance(selectedTool)}
					${renderToolDiagnosticsPanel(toolDiagnosticEntries(selectedTool), "Tool diagnostics")}
					<div class="tools-identity-row">
						<label class="tools-field-label">Name</label>
						<div class="tools-field-readonly">${selectedTool.name}</div>
						<label class="tools-field-label" style="margin-left:8px;">Group</label>
						<select class="tools-select" style="width:auto"
							.value=${editGroup}
							@change=${(e: Event) => { editGroup = (e.target as HTMLSelectElement).value; renderApp(); }}>
							${TOOL_GROUPS.map((g) => html`<option value=${g} ?selected=${editGroup === g}>${g}</option>`)}
						</select>
					</div>
					<div class="tools-identity-row">
						<label class="tools-field-label">Description</label>
						<input class="tools-input"
							.value=${editDescription}
							placeholder="Short description of what this tool does"
							@input=${(e: Event) => { editDescription = (e.target as HTMLInputElement).value; renderApp(); }} />
					</div>
				</div>

				<!-- Sub-tab row -->
				<div class="tools-tab-bar">
					<button class="tools-tab ${editTab === "access" ? "tools-tab--active" : ""}"
						@click=${() => { editTab = "access"; renderApp(); }}>Access</button>
					<button class="tools-tab ${editTab === "context" ? "tools-tab--active" : ""}"
						@click=${() => { editTab = "context"; renderApp(); }}>Context</button>
					<button class="tools-tab ${editTab === "renderer" ? "tools-tab--active" : ""}"
						@click=${() => { editTab = "renderer"; renderApp(); }}>Renderer</button>
				</div>

				<!-- Tab content -->
				<div class="tools-tab-content">
					${renderActiveTab()}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// CUSTOMIZE / REVERT
// ============================================================================

function renderCustomizeRevertButtons(): TemplateResult | string {
	if (!selectedTool) return "";
	const origin = isConfigOrigin(selectedTool.origin) ? selectedTool.origin : undefined;
	const providers = selectedTool.providers ?? [];

	// Market-pack entities are read-only — managed via the Marketplace (install/
	// uninstall), NOT the legacy customize/override endpoints (which can't remove
	// an installed pack). Gate the actions off when the entity carries a pack tag.
	// See docs/design/pack-based-marketplace.md §3.2 / finding #2.
	const originPackName = selectedTool.originPackName || providers[0]?.packName || null;
	const originPackId = selectedTool.originPackId || null;
	if (originPackName || originPackId || isPiExtensionTool(selectedTool)) {
		return html`<span class="config-readonly-note" data-testid="market-readonly-note"
			title="Installed from pack '${originPackName ?? originPackId ?? "pi extension"}'. Manage it in the Marketplace.">Manage in Marketplace</span>`;
	}
	if (!origin) return "";

	const scope = getConfigScope();
	const projectId = getConfigApiProjectId();

	if (scope === "system") {
		if (origin === "builtin") {
			return html`<button class="config-action-btn" @click=${async () => {
				if (await customizeItem("tools", selectedTool!.name, "server", projectId)) {
					tools = await fetchToolsScoped();
					const updated = tools.find(t => t.name === selectedTool!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Customize in Headquarters</button>`;
		}
		if (origin === "server") {
			return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
				if (await revertOverride("tools", selectedTool!.name, "server", projectId)) {
					tools = await fetchToolsScoped();
					const updated = tools.find(t => t.name === selectedTool!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Revert to Builtin</button>`;
		}
	} else {
		if (origin === "builtin" || origin === "server") {
			return html`<button class="config-action-btn" @click=${async () => {
				if (await customizeItem("tools", selectedTool!.name, "project", projectId)) {
					tools = await fetchToolsScoped();
					const updated = tools.find(t => t.name === selectedTool!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Customize for ${getCurrentProjectName()}</button>`;
		}
		if (origin === "project") {
			return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
				if (await revertOverride("tools", selectedTool!.name, "project", projectId)) {
					tools = await fetchToolsScoped();
					const updated = tools.find(t => t.name === selectedTool!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Revert to Headquarters</button>`;
		}
	}
	return "";
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderToolManagerPage(): TemplateResult {
	return html`
		<div class="tools-container">
			${renderNavBar()}
			${currentView === "list" ? renderConfigScopeRow(getConfigScope(), handleScopeChange) : ""}
			<div class="tools-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
