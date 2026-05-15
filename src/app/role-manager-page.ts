// CSS for this page is eagerly imported from main.ts (see comment there).
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import { fetchTools, updateRole, deleteRole, gatewayFetch, fetchAssistantPrompts, updateAssistantPrompt, fetchGroupPolicies, type RoleData, type ToolInfo, type AssistantPromptInfo } from "./api.js";
import { errorFromResponse, errorDetails } from "./error-helpers.js";
import { connectToSession } from "./session-manager.js";
import { showConnectionError, confirmAction } from "./dialogs.js";
import { ACCESSORY_IDS, getAccessory } from "./session-colors.js";
import { renderIdleBlobCanvas } from "../ui/bobbit-render.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { type ConfigOrigin, getConfigScope, setConfigScope, getConfigProjectId, renderOriginBadge, isInherited, renderConfigScopeRow, customizeItem, revertOverride, getCurrentProjectName } from "./config-scope.js";
import { renderModelRow } from "./settings-page.js";

// ============================================================================
// HELPERS
// ============================================================================

/** Render an idle in-chat blob with the given accessory in a self-contained box. */
function idleBlob(accId: string, size = 40, hueIndex = 0, phaseIndex = 0): TemplateResult {
	const accClass = accId && accId !== "none"
		? `bobbit-${accId === "crown" ? "crowned" : accId}`
		: "";
	return renderIdleBlobCanvas({ accId, accClass, size, hueIndex, phaseIndex });
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ROLE_POLICY_OPTIONS = [
	{ value: "", label: "Use tool default" },
	{ value: "allow", label: "Allow" },
	{ value: "ask", label: "Ask" },
	{ value: "never", label: "Never" },
];

const POLICY_LABELS: Record<string, string> = {
	"allow": "Allow",
	"ask": "Ask",
	"never": "Never",
};

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit" | "create";

let currentView: View = "list";
let roles: RoleData[] = [];
let availableTools: ToolInfo[] = [];
let selectedRole: RoleData | null = null;
let loading = true;

// Edit form state
let editLabel = "";
let editPrompt = "";
let editAccessory = "none";
let editToolPolicies: Record<string, string> = {};
let editModelOverride = "";
let editThinkingOverride = "";
let editTab: "prompt" | "tools" | "model" = "prompt";

let saving = false;
let deleting = false;

// Group policies loaded from server
let groupPolicies: Record<string, string> = {};

// Collapsible group state for Tool Access tab (all collapsed by default)
let collapsedGroups = new Set<string>();

// Assistant sub-prompt state
let assistantPrompts: AssistantPromptInfo[] = [];
let activePromptTab: string = "baseline"; // "baseline" or assistant type key
let editedPrompts: Map<string, string> = new Map(); // type -> edited content
let originalPrompts: Map<string, string> = new Map(); // type -> original content (for dirty detection)

// ============================================================================
// DATA LOADING
// ============================================================================

async function fetchRolesScoped(): Promise<RoleData[]> {
	const projectId = getConfigProjectId();
	const url = projectId ? `/api/roles?projectId=${encodeURIComponent(projectId)}` : "/api/roles";
	try {
		const res = await gatewayFetch(url);
		if (!res.ok) return [];
		const data = await res.json();
		const rolesList: RoleData[] = data.roles || data || [];
		return rolesList;
	} catch {
		return [];
	}
}

export async function loadRolePageData(): Promise<void> {
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	const [r, t, gp] = await Promise.all([fetchRolesScoped(), fetchTools(), fetchGroupPolicies()]);
	roles = r;
	availableTools = t;
	groupPolicies = gp;
	loading = false;
	renderApp();
}

export function clearRolePageState(): void {
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedRole = null;
	setHashRoute("roles");
}

function initEditState(role: RoleData): void {
	currentView = "edit";
	selectedRole = role;
	editLabel = role.label;
	editPrompt = role.promptTemplate;
	editAccessory = role.accessory;
	editToolPolicies = { ...(role.toolPolicies ?? {}) };
	editModelOverride = role.model ?? "";
	editThinkingOverride = role.thinkingLevel ?? "";
	editTab = "prompt";
	saving = false;
	deleting = false;
	// Collapse all tool groups by default
	collapsedGroups = new Set<string>(availableTools.map(t => t.group || "Other"));
	activePromptTab = "baseline";
	editedPrompts = new Map();
	originalPrompts = new Map();
	if (role.name === "assistant") {
		fetchAssistantPrompts().then((prompts) => {
			assistantPrompts = prompts;
			editedPrompts = new Map(prompts.map((p) => [p.type, p.prompt]));
			originalPrompts = new Map(prompts.map((p) => [p.type, p.prompt]));
			renderApp();
		});
	} else {
		assistantPrompts = [];
	}
}

function showEdit(role: RoleData): void {
	initEditState(role);
	setHashRoute("role-edit", role.name);
}

/** Called by the main router when navigating to #/roles/:name */
export function navigateToRoleEdit(roleName: string): void {
	const role = roles.find((r) => r.name === roleName);
	if (role) {
		initEditState(role);
	} else {
		currentView = "list";
		selectedRole = null;
	}
	renderApp();
}

async function createRoleAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const bodyObj: Record<string, any> = { assistantType: "role" };
		const projectId = getConfigProjectId();
		if (projectId) {
			bodyObj.projectId = projectId;
			const project = state.projects.find(p => p.id === projectId);
			if (project) bodyObj.cwd = project.rootPath;
		}
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(bodyObj),
		});
		if (!res.ok) {
			throw await errorFromResponse(res, `Session creation failed: ${res.status}`);
		}
		const { id } = await res.json();
		await connectToSession(id, false, { assistantType: "role" });
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create role assistant", message, { code, stack });
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	if (selectedRole) {
		const projectId = getConfigProjectId();
		const ok = await updateRole(selectedRole.name, {
			label: editLabel,
			promptTemplate: editPrompt,
			accessory: editAccessory,
			toolPolicies: Object.keys(editToolPolicies).length > 0 ? editToolPolicies : {},
			model: editModelOverride,
			thinkingLevel: editThinkingOverride,
		}, projectId || undefined);

		// Save dirty sub-prompts
		const dirtyPrompts = Array.from(editedPrompts.entries()).filter(
			([type, content]) => content !== (originalPrompts.get(type) ?? ""),
		);
		if (dirtyPrompts.length > 0) {
			await Promise.all(
				dirtyPrompts.map(([type, content]) => updateAssistantPrompt(type, content)),
			);
		}

		if (ok) {
			const [r] = await Promise.all([fetchRolesScoped()]);
			roles = r;
			const updated = roles.find((r) => r.name === selectedRole!.name);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(): Promise<void> {
	if (!selectedRole) return;
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${selectedRole.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	deleting = true;
	renderApp();
	const ok = await deleteRole(selectedRole.name, getConfigProjectId() || undefined);
	if (ok) {
		const [r] = await Promise.all([fetchRolesScoped()]);
		roles = r;
		showList();
	} else {
		deleting = false;
		renderApp();
	}
}

// ============================================================================
// STATELESS RENDERER OPTION TYPES (exported for modal/goal-draft reuse)
// ============================================================================

/**
 * Scope hint for embedded renderers.
 *  - "page":       default Roles page usage; full chrome (delete, customize, scope row).
 *  - "goal-draft": embedded in goal proposal modal; library-mutation actions hidden.
 */
export type RoleRendererScope = "page" | "goal-draft";

export interface RoleListOptions {
	roles: RoleData[];
	selectedName?: string | null;
	/** Names of roles that have been customized for the current draft. */
	customizedNames?: ReadonlySet<string> | string[];
	onSelect: (role: RoleData) => void;
	/** Optional per-row edit button. Defaults to onSelect. */
	onEdit?: (role: RoleData) => void;
	/** Optional per-row delete button. When omitted, delete action is hidden. */
	onDelete?: (role: RoleData) => void;
	loading?: boolean;
	scope?: RoleRendererScope;
	/** Optional empty-state action button shown when roles is empty. */
	emptyAction?: TemplateResult;
}

export interface RoleEditorDraft {
	label: string;
	promptTemplate: string;
	accessory: string;
	toolPolicies: Record<string, string>;
	model: string;
	thinkingLevel: string;
	activeTab: "prompt" | "tools" | "model";
}

export interface RoleEditorCallbacks {
	onDraftChange: (patch: Partial<RoleEditorDraft>) => void;
	onTabChange: (tab: "prompt" | "tools" | "model") => void;
	onToggleToolGroup: (group: string) => void;
}

export interface RoleEditorOptions {
	role: RoleData;
	draft: RoleEditorDraft;
	availableTools: ToolInfo[];
	groupPolicies: Record<string, string>;
	collapsedToolGroups: ReadonlySet<string>;
	callbacks: RoleEditorCallbacks;
	scope?: RoleRendererScope;
	/** When true, all inputs are disabled and library-mutation chrome is hidden. */
	readOnly?: boolean;
	/** Optional header slot (e.g. Customize / Reset buttons in goal-draft scope). */
	headerExtras?: TemplateResult | string;
	/** Assistant sub-prompts — page-shell only. */
	assistantPrompts?: AssistantPromptInfo[];
	editedAssistantPrompts?: Map<string, string>;
	activeAssistantPromptTab?: string;
	onAssistantPromptTabChange?: (tab: string) => void;
	onAssistantPromptChange?: (type: string, content: string) => void;
}

export interface RoleInspectorOptions {
	role: RoleData;
	availableTools: ToolInfo[];
	groupPolicies: Record<string, string>;
	scope?: RoleRendererScope;
	headerExtras?: TemplateResult | string;
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView !== "list" && selectedRole) {
		const subPromptsDirty = Array.from(editedPrompts.entries()).some(
			([type, content]) => content !== (originalPrompts.get(type) ?? ""),
		);
		const toolPoliciesChanged = JSON.stringify(editToolPolicies) !== JSON.stringify(selectedRole?.toolPolicies ?? {});
		const modelChanged = (editModelOverride || "") !== (selectedRole?.model || "");
		const thinkingChanged = (editThinkingOverride || "") !== (selectedRole?.thinkingLevel || "");
		const hasChanges = selectedRole && (
			editLabel !== selectedRole.label ||
			editPrompt !== selectedRole.promptTemplate ||
			editAccessory !== selectedRole.accessory ||
			toolPoliciesChanged ||
			modelChanged ||
			thinkingChanged ||
			subPromptsDirty
		);
		return html`
			<div class="roles-nav">
				<div class="roles-nav-left">
					<button class="roles-back" @click=${showList} title="Back to roles">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="roles-title-group">
						<span class="roles-breadcrumb" @click=${showList}>Roles</span>
						<span class="roles-breadcrumb-sep">/</span>
						<h1 class="roles-title">${selectedRole.label}</h1>
					</div>
				</div>
				<div class="roles-nav-right">
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: handleDelete,
						disabled: deleting,
						className: "text-destructive hover:text-destructive hover:bg-destructive/10",
						children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} ${deleting ? "Deleting\u2026" : "Delete"}</span>`,
					})}
					<span data-testid="role-save-btn">${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || !hasChanges,
						children: saving ? "Saving\u2026" : "Save",
					})}</span>
				</div>
			</div>
		`;
	}

	// List view: back goes to sessions
	return html`
		<div class="roles-nav">
			<div class="roles-nav-left">
				<button class="roles-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="roles-title">Roles</h1>
			</div>
			<div class="roles-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: createRoleAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Role</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: ROLE ROWS (list view)
// ============================================================================

async function handleDeleteFromList(role: RoleData): Promise<void> {
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${role.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteRole(role.name, getConfigProjectId() || undefined);
	if (ok) {
		const [r] = await Promise.all([fetchRolesScoped()]);
		roles = r;
		renderApp();
	}
}

async function handleScopeChange(scope: string): Promise<void> {
	setConfigScope(scope);
	loading = true;
	renderApp();
	roles = await fetchRolesScoped();
	loading = false;
	renderApp();
}

interface RoleRowOptions {
	role: RoleData;
	index: number;
	selected?: boolean;
	customized?: boolean;
	onSelect: (role: RoleData) => void;
	onEdit?: (role: RoleData) => void;
	onDelete?: (role: RoleData) => void;
}

/** Stateless row renderer; used by both the page list and the goal-draft modal. */
export function renderRoleListRow(opts: RoleRowOptions): TemplateResult {
	const { role, index, selected, customized, onSelect, onEdit, onDelete } = opts;
	const origin = (role as any).origin as ConfigOrigin | undefined;
	const overrides = (role as any).overrides as ConfigOrigin | undefined;
	const inherited = isInherited(origin);
	const classes = [
		"role-row",
		inherited ? "config-item-inherited" : "",
		selected ? "role-row--selected" : "",
		customized ? "role-row--customized" : "",
	].filter(Boolean).join(" ");
	return html`
		<div class="${classes}" data-role-name="${role.name}" tabindex="0" role="button"
			?aria-selected=${!!selected}
			@click=${() => onSelect(role)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(role); } }}>
			${idleBlob(role.accessory ?? "none", 42, index, index)}
			<div class="role-row-info">
				<span class="role-row-label">${role.label}${customized ? html` <span class="role-row-customized-marker" title="Customized for this goal">●</span>` : nothing}</span>
				<span class="role-row-slug">${role.name} ${renderOriginBadge(origin, overrides)}</span>
			</div>
			<div class="role-row-actions">
				${onEdit ? html`<button class="role-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); onEdit(role); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>` : nothing}
				${onDelete ? html`<button class="role-row-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); onDelete(role); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>` : nothing}
			</div>
		</div>
	`;
}

/**
 * Stateless list renderer. The Roles page calls this with module state;
 * the goal proposal modal calls it with draft-scoped state.
 */
export function renderRoleList(opts: RoleListOptions): TemplateResult {
	const { roles, selectedName, onSelect, onEdit, onDelete, loading, emptyAction } = opts;
	const customizedSet = opts.customizedNames instanceof Set
		? opts.customizedNames
		: new Set<string>(Array.isArray(opts.customizedNames) ? opts.customizedNames : []);

	if (loading) {
		return html`
			<div class="roles-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading roles…</span>
			</div>
		`;
	}

	if (roles.length === 0) {
		return html`
			<div class="roles-empty">
				<div class="roles-empty-bobbit">${idleBlob("none", 52)}</div>
				<p class="roles-empty-title">No roles yet</p>
				<p class="roles-empty-desc">Roles give agents a persona, system prompt, and tool restrictions.</p>
				${emptyAction ?? nothing}
			</div>
		`;
	}

	return html`
		<div class="roles-list">
			${roles.map((role, i) => renderRoleListRow({
				role,
				index: i,
				selected: selectedName === role.name,
				customized: customizedSet.has(role.name),
				onSelect,
				onEdit,
				onDelete,
			}))}
		</div>
	`;
}



function renderListView(): TemplateResult {
	const emptyAction = Button({
		variant: "default",
		onClick: createRoleAssistantSession,
		children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first role</span>`,
	}) as TemplateResult;

	const list = renderRoleList({
		roles,
		loading,
		onSelect: (r) => showEdit(r),
		onEdit: (r) => showEdit(r),
		onDelete: (r) => handleDeleteFromList(r),
		emptyAction,
	});

	if (loading || roles.length === 0) return list;

	return html`
		<p class="text-sm text-muted-foreground mb-6" style="max-width: 600px; margin-inline: auto;">Roles define what an agent can do \u2014 its system prompt and which tools it has access to. Bobbit includes built-in roles (coder, reviewer, tester) and you can create custom ones.</p>
		${list}
	`;
}

// ============================================================================
// RENDER: TOOL ACCESS TAB
// ============================================================================

function toggleGroup(group: string): void {
	if (collapsedGroups.has(group)) {
		collapsedGroups.delete(group);
	} else {
		collapsedGroups.add(group);
	}
	renderApp();
}

/** Resolve effective policy purely from passed-in state — used by stateless tab renderer. */
function resolvePolicy(
	toolName: string,
	toolGroup: string,
	toolPolicies: Record<string, string>,
	tools: ToolInfo[],
	groupPolicyMap: Record<string, string>,
): { effective: string; source: string } {
	if (toolPolicies[toolName]) return { effective: toolPolicies[toolName], source: "role override" };
	const parts = toolName.split("__");
	if (parts.length >= 3) {
		const serverPrefix = parts.slice(0, 2).join("__");
		if (toolPolicies[serverPrefix]) return { effective: toolPolicies[serverPrefix], source: `from ${serverPrefix}` };
	}
	if (toolPolicies[toolGroup]) return { effective: toolPolicies[toolGroup], source: `from ${toolGroup} role override` };
	const tool = tools.find(t => t.name === toolName);
	if (tool?.grantPolicy) return { effective: tool.grantPolicy, source: "tool default" };
	if (groupPolicyMap[toolGroup]) return { effective: groupPolicyMap[toolGroup], source: "group default" };
	return { effective: "allow", source: "system default" };
}

export interface RoleToolAccessTabOptions {
	toolPolicies: Record<string, string>;
	availableTools: ToolInfo[];
	groupPolicies: Record<string, string>;
	collapsedToolGroups: ReadonlySet<string>;
	onPolicyChange: (toolOrGroup: string, newPolicy: string) => void;
	onToggleGroup: (group: string) => void;
	readOnly?: boolean;
}

export function renderRoleToolAccessTab(opts: RoleToolAccessTabOptions): TemplateResult {
	const { toolPolicies, availableTools: tools, groupPolicies: gp, collapsedToolGroups, onPolicyChange, onToggleGroup, readOnly } = opts;

	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const g = tool.group || "Other";
		const list = groups.get(g) || [];
		list.push(tool);
		groups.set(g, list);
	}

	const chevronSvg = html`<svg class="roles-access-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

	return html`
		<p class="roles-tools-note">Set per-tool access policies for this role. Tools left at "Use default" inherit from tool, group, or system defaults.</p>
		<div class="roles-access-list">
			${Array.from(groups.entries()).map(([groupName, groupTools]) => {
				const isCollapsed = collapsedToolGroups.has(groupName);

				return html`
					<div class="roles-access-group ${isCollapsed ? "collapsed" : ""}">
						<div class="roles-access-group-header" @click=${() => onToggleGroup(groupName)}>
							${chevronSvg}
							<span class="roles-access-group-name">${groupName}</span>
							<span class="roles-access-group-count">${groupTools.length} tool${groupTools.length !== 1 ? "s" : ""}</span>
							<span class="roles-access-group-policy-label">Group Policy:</span>
							<select class="roles-access-group-select"
								.value=${toolPolicies[groupName] || ""}
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => { e.stopPropagation(); onPolicyChange(groupName, (e.target as HTMLSelectElement).value); }}
							>
								<option value="" ?selected=${!toolPolicies[groupName]}>Use tool default</option>
								${ROLE_POLICY_OPTIONS.filter(opt => opt.value !== "").map(opt => html`
									<option value=${opt.value} ?selected=${toolPolicies[groupName] === opt.value}>${opt.label}</option>
								`)}
							</select>
							<span class="roles-access-group-hint">${(() => {
								const groupDefault = gp[groupName] || "allow";
								const label = POLICY_LABELS[groupDefault] || groupDefault;
								return html`\u2192 ${label} [system default]`;
							})()}</span>
						</div>
						<div class="roles-access-group-items">
							${groupTools.map(tool => {
								const currentPolicy = toolPolicies[tool.name] || "";
								const hasGroupOverride = !!toolPolicies[groupName];
								const defaultLabel = hasGroupOverride ? "Use group role default" : "Use tool default";
								const { effective, source } = resolvePolicy(tool.name, groupName, toolPolicies, tools, gp);
								const effectiveLabel = POLICY_LABELS[effective] || effective;
								return html`
									<div class="roles-access-row">
										<span class="roles-access-row-label" title="${tool.description}">${tool.name}</span>
										<select
											class="roles-access-row-select"
											.value=${currentPolicy}
											?disabled=${readOnly}
											@change=${(e: Event) => onPolicyChange(tool.name, (e.target as HTMLSelectElement).value)}
										>
											<option value="" ?selected=${!currentPolicy}>${defaultLabel}</option>
											${ROLE_POLICY_OPTIONS.filter(opt => opt.value !== "").map(opt => html`
												<option value=${opt.value} ?selected=${currentPolicy === opt.value}>${opt.label}</option>
											`)}
										</select>
										<span class="roles-access-row-hint">\u2192 ${effectiveLabel} [${source}]</span>
									</div>
								`;
							})}
						</div>
					</div>
				`;
			})}
		</div>
	`;
}



// ============================================================================
// RENDER: PROMPT TAB
// ============================================================================

export interface RolePromptTabOptions {
	roleName: string;
	promptTemplate: string;
	onPromptChange: (value: string) => void;
	readOnly?: boolean;
	assistantPrompts?: AssistantPromptInfo[];
	editedAssistantPrompts?: Map<string, string>;
	activeAssistantPromptTab?: string;
	onAssistantPromptTabChange?: (tab: string) => void;
	onAssistantPromptChange?: (type: string, content: string) => void;
}

export function renderRolePromptTab(opts: RolePromptTabOptions): TemplateResult {
	const {
		roleName,
		promptTemplate,
		onPromptChange,
		readOnly,
		assistantPrompts: aPrompts = [],
		editedAssistantPrompts: ePrompts = new Map(),
		activeAssistantPromptTab: activeTab = "baseline",
		onAssistantPromptTabChange,
		onAssistantPromptChange,
	} = opts;
	const hasAssistantTabs = roleName === "assistant" && aPrompts.length > 0;
	const showBaseline = !hasAssistantTabs || activeTab === "baseline";
	return html`
		${hasAssistantTabs ? html`
			<div class="roles-prompt-tabs">
				<button
					class="roles-prompt-tab ${activeTab === "baseline" ? "roles-prompt-tab--active" : ""}"
					@click=${() => onAssistantPromptTabChange?.("baseline")}
				>Shared Baseline</button>
				${aPrompts.map((p) => html`
					<button
						class="roles-prompt-tab ${activeTab === p.type ? "roles-prompt-tab--active" : ""}"
						@click=${() => onAssistantPromptTabChange?.(p.type)}
					>${p.title.replace(" Assistant", "").replace(" Wizard", "")}</button>
				`)}
			</div>
		` : nothing}
		${showBaseline ? html`
			<textarea
				class="roles-prompt-editor"
				.value=${promptTemplate}
				?readonly=${readOnly}
				placeholder="Markdown system prompt template. Supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders."
				@input=${(e: Event) => onPromptChange((e.target as HTMLTextAreaElement).value)}
			></textarea>
		` : html`
			<p class="roles-prompt-hint">This prompt is appended after the shared baseline for ${aPrompts.find((p) => p.type === activeTab)?.title ?? activeTab} sessions.</p>
			<textarea
				class="roles-prompt-editor"
				.value=${ePrompts.get(activeTab) ?? ""}
				?readonly=${readOnly}
				@input=${(e: Event) => onAssistantPromptChange?.(activeTab, (e.target as HTMLTextAreaElement).value)}
			></textarea>
		`}
	`;
}



// ============================================================================
// RENDER: MODEL TAB
// ============================================================================

export interface RoleModelTabOptions {
	model: string;
	thinkingLevel: string;
	onModelChange: (v: string) => void;
	onThinkingChange: (v: string) => void;
	readOnly?: boolean;
}

export function renderRoleModelTab(opts: RoleModelTabOptions): TemplateResult {
	const { model, thinkingLevel, onModelChange, onThinkingChange } = opts;
	return html`
		<p class="roles-tools-note" data-testid="roles-model-tab">
			Overrides the global default for sessions running as this role. Leave blank to inherit.
		</p>
		${renderModelRow(
			"Model",
			"When set, sessions assuming this role bind to this model on first turn. Empty = inherit default.sessionModel (or default.reviewModel for reviewer/QA sessions).",
			model,
			onModelChange,
			thinkingLevel,
			onThinkingChange,
			"",
			{ fallbackLabel: "(use default)" },
		)}
	`;
}



// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

/**
 * Stateless role editor. Renders identity, accessory, and tabbed prompt/tools/model panes.
 * Shared by the Roles page (page shell) and the goal proposal modal (goal-draft scope).
 * Pass `readOnly: true` to use as a read-only inspector.
 */
export function renderRoleEditor(opts: RoleEditorOptions): TemplateResult {
	const {
		role,
		draft,
		availableTools: tools,
		groupPolicies: gp,
		collapsedToolGroups,
		callbacks,
		readOnly,
		headerExtras,
		assistantPrompts: aPrompts,
		editedAssistantPrompts,
		activeAssistantPromptTab,
		onAssistantPromptTabChange,
		onAssistantPromptChange,
	} = opts;
	const origin = (role as any).origin as ConfigOrigin | undefined;
	const overrides = (role as any).overrides as ConfigOrigin | undefined;
	return html`
		<div class="roles-edit-container" data-testid="role-editor" data-role-name="${role.name}" data-scope="${opts.scope ?? "page"}">
			<div class="roles-edit-main">
				<!-- Identity section -->
				<div class="roles-edit-section">
					<div class="flex items-center justify-between">
						<h2 class="roles-section-title">Identity</h2>
						<span class="inline-flex items-center gap-2">
							${renderOriginBadge(origin, overrides)}
							${headerExtras ?? nothing}
						</span>
					</div>
					<div class="roles-identity-row">
						<div class="roles-edit-field">
							<label class="roles-field-label">Id</label>
							<div class="roles-field-readonly">${role.name}</div>
						</div>
						<div class="roles-edit-field" style="flex:1;min-width:0;">
							<label class="roles-field-label">Label</label>
							${Input({
								value: draft.label,
								placeholder: "e.g. Documentation Writer",
								disabled: !!readOnly,
								onInput: (e: Event) => callbacks.onDraftChange({ label: (e.target as HTMLInputElement).value }),
							})}
						</div>
					</div>
				</div>

				<!-- Accessory selector -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">Accessory</h2>
					<div class="roles-accessory-grid">
						${ACCESSORY_IDS.map((accId, i) => {
							const acc = getAccessory(accId);
							const selected = draft.accessory === accId;
							return html`
								<button
									class="roles-accessory-option ${selected ? "roles-accessory-option--selected" : ""}"
									title="${acc.label}"
									?disabled=${readOnly}
									@click=${() => { if (!readOnly) callbacks.onDraftChange({ accessory: accId }); }}
								>
									<span class="roles-accessory-preview">
										${idleBlob(accId, 42, i, i)}
									</span>
									<span class="roles-accessory-label">${acc.label}</span>
								</button>
							`;
						})}
					</div>
				</div>

				<!-- Tab bar -->
				<div class="roles-tab-bar">
					<button class="roles-tab ${draft.activeTab === "prompt" ? "roles-tab--active" : ""}"
						@click=${() => callbacks.onTabChange("prompt")}>Prompt</button>
					<button class="roles-tab ${draft.activeTab === "tools" ? "roles-tab--active" : ""}"
						@click=${() => callbacks.onTabChange("tools")}>Tool Access</button>
					<button class="roles-tab ${draft.activeTab === "model" ? "roles-tab--active" : ""}"
						@click=${() => callbacks.onTabChange("model")} data-testid="roles-tab-model">Model</button>
				</div>

				<!-- Tab content -->
				<div class="roles-tab-content">
					${draft.activeTab === "prompt"
						? renderRolePromptTab({
								roleName: role.name,
								promptTemplate: draft.promptTemplate,
								onPromptChange: (v) => callbacks.onDraftChange({ promptTemplate: v }),
								readOnly,
								assistantPrompts: aPrompts,
								editedAssistantPrompts,
								activeAssistantPromptTab,
								onAssistantPromptTabChange,
								onAssistantPromptChange,
						  })
						: draft.activeTab === "tools"
						? renderRoleToolAccessTab({
								toolPolicies: draft.toolPolicies,
								availableTools: tools,
								groupPolicies: gp,
								collapsedToolGroups,
								onPolicyChange: (toolOrGroup, newPolicy) => {
									const next = { ...draft.toolPolicies };
									if (newPolicy) next[toolOrGroup] = newPolicy;
									else delete next[toolOrGroup];
									callbacks.onDraftChange({ toolPolicies: next });
								},
								onToggleGroup: callbacks.onToggleToolGroup,
								readOnly,
						  })
						: renderRoleModelTab({
								model: draft.model,
								thinkingLevel: draft.thinkingLevel,
								onModelChange: (v) => callbacks.onDraftChange({ model: v }),
								onThinkingChange: (v) => callbacks.onDraftChange({ thinkingLevel: v }),
								readOnly,
						  })}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// READ-ONLY INSPECTOR — interactive view state
//
// The inspector renders the full shared `renderRoleEditor` with `readOnly:
// true` so all draft mutations are blocked, but UI-only state (which tab is
// active, which tool groups are collapsed) is interactive — the user MUST be
// able to flip between Prompt / Tool Access / Model to inspect a role they
// might want to customise. Mutating project library state is still impossible
// because every `onDraftChange` call is a noop.
// ============================================================================
let _inspectorRoleName: string | null = null;
let _inspectorActiveTab: "prompt" | "tools" | "model" = "prompt";
let _inspectorCollapsedGroups: Set<string> = new Set();

/**
 * Stateless read-only inspector. Renders the same DOM as the editor but with all
 * data-mutating controls disabled. Tab switching and group collapse remain
 * interactive (view-only — they do not touch the role itself or the project
 * library), so the user can inspect prompt, tool access, and model fields in
 * the goal-draft modal.
 */
export function renderRoleInspector(opts: RoleInspectorOptions): TemplateResult {
	if (_inspectorRoleName !== opts.role.name) {
		_inspectorRoleName = opts.role.name;
		_inspectorActiveTab = "prompt";
		// Start with all tool groups collapsed (matches editor first-open).
		_inspectorCollapsedGroups = new Set<string>(
			opts.availableTools.map((t) => t.group || "Other"),
		);
	}
	const inspectorDraft: RoleEditorDraft = {
		label: opts.role.label,
		promptTemplate: opts.role.promptTemplate,
		accessory: opts.role.accessory ?? "none",
		toolPolicies: { ...(opts.role.toolPolicies ?? {}) },
		model: opts.role.model ?? "",
		thinkingLevel: opts.role.thinkingLevel ?? "",
		activeTab: _inspectorActiveTab,
	};
	const noop = () => {};
	return renderRoleEditor({
		role: opts.role,
		draft: inspectorDraft,
		availableTools: opts.availableTools,
		groupPolicies: opts.groupPolicies,
		collapsedToolGroups: _inspectorCollapsedGroups,
		callbacks: {
			onDraftChange: noop,
			onTabChange: (tab) => { _inspectorActiveTab = tab; renderApp(); },
			onToggleToolGroup: (g) => {
				if (_inspectorCollapsedGroups.has(g)) _inspectorCollapsedGroups.delete(g);
				else _inspectorCollapsedGroups.add(g);
				renderApp();
			},
		},
		readOnly: true,
		scope: opts.scope ?? "goal-draft",
		headerExtras: opts.headerExtras,
	});
}

function renderEditView(): TemplateResult {
	if (!selectedRole) return html``;
	const draft: RoleEditorDraft = {
		label: editLabel,
		promptTemplate: editPrompt,
		accessory: editAccessory,
		toolPolicies: editToolPolicies,
		model: editModelOverride,
		thinkingLevel: editThinkingOverride,
		activeTab: editTab,
	};
	return renderRoleEditor({
		role: selectedRole,
		draft,
		availableTools,
		groupPolicies,
		collapsedToolGroups: collapsedGroups,
		callbacks: {
			onDraftChange: (patch) => {
				if (patch.label !== undefined) editLabel = patch.label;
				if (patch.promptTemplate !== undefined) editPrompt = patch.promptTemplate;
				if (patch.accessory !== undefined) editAccessory = patch.accessory;
				if (patch.toolPolicies !== undefined) editToolPolicies = patch.toolPolicies;
				if (patch.model !== undefined) editModelOverride = patch.model;
				if (patch.thinkingLevel !== undefined) editThinkingOverride = patch.thinkingLevel;
				renderApp();
			},
			onTabChange: (tab) => { editTab = tab; renderApp(); },
			onToggleToolGroup: (g) => toggleGroup(g),
		},
		scope: "page",
		headerExtras: renderCustomizeRevertButtons() as TemplateResult,
		assistantPrompts,
		editedAssistantPrompts: editedPrompts,
		activeAssistantPromptTab: activePromptTab,
		onAssistantPromptTabChange: (tab) => { activePromptTab = tab; renderApp(); },
		onAssistantPromptChange: (type, content) => { editedPrompts.set(type, content); renderApp(); },
	});
}

// ============================================================================
// MAIN RENDER
// ============================================================================

function renderCustomizeRevertButtons(): TemplateResult | string {
	if (!selectedRole) return "";
	const origin = (selectedRole as any).origin as ConfigOrigin | undefined;
	if (!origin) return "";

	const scope = getConfigScope();
	const projectId = getConfigProjectId();

	if (scope === "system") {
		if (origin === "builtin") {
			return html`<button class="config-action-btn" @click=${async () => {
				if (await customizeItem("roles", selectedRole!.name, "server")) {
					roles = await fetchRolesScoped();
					const updated = roles.find(r => r.name === selectedRole!.name);
					if (updated) showEdit(updated);
				}
			}}>Customize at Server Level</button>`;
		}
		if (origin === "server") {
			return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
				if (await revertOverride("roles", selectedRole!.name, "server")) {
					roles = await fetchRolesScoped();
					const updated = roles.find(r => r.name === selectedRole!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Revert to Builtin</button>`;
		}
	} else {
		if (origin === "builtin" || origin === "server") {
			return html`<button class="config-action-btn" @click=${async () => {
				if (await customizeItem("roles", selectedRole!.name, "project", projectId)) {
					roles = await fetchRolesScoped();
					const updated = roles.find(r => r.name === selectedRole!.name);
					if (updated) showEdit(updated);
				}
			}}>Customize for ${getCurrentProjectName()}</button>`;
		}
		if (origin === "project") {
			return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
				if (await revertOverride("roles", selectedRole!.name, "project", projectId)) {
					roles = await fetchRolesScoped();
					const updated = roles.find(r => r.name === selectedRole!.name);
					if (updated) showEdit(updated); else showList();
				}
			}}>Revert to Inherited</button>`;
		}
	}
	return "";
}

export function renderRoleManagerPage(): TemplateResult {
	return html`
		<div class="roles-container">
			${renderNavBar()}
			${currentView === "list" ? renderConfigScopeRow(getConfigScope(), handleScopeChange) : ""}
			<div class="roles-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
