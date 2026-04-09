import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import { fetchRoles, fetchTools, updateRole, deleteRole, gatewayFetch, fetchAssistantPrompts, updateAssistantPrompt, fetchGroupPolicies, type RoleData, type ToolInfo, type AssistantPromptInfo } from "./api.js";
import { ACCESSORY_IDS, getAccessory } from "./session-colors.js";
import { renderIdleBlobCanvas } from "../ui/bobbit-render.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { type ConfigOrigin, getConfigScope, setConfigScope, getConfigProjectId, renderOriginBadge, isInherited, renderConfigScopeRow, customizeItem, revertOverride, getCurrentProjectName } from "./config-scope.js";

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
let editName = "";
let editToolPolicies: Record<string, string> = {};
let editTab: "prompt" | "tools" = "prompt";

let saving = false;
let deleting = false;

// Group policies loaded from server
let groupPolicies: Record<string, string> = {};

// Collapsible group state for Tool Access tab (all expanded by default)
let collapsedGroups = new Set<string>();

// Assistant sub-prompt state
let assistantPrompts: AssistantPromptInfo[] = [];
let activePromptTab: string = "baseline"; // "baseline" or assistant type key
let editedPrompts: Map<string, string> = new Map(); // type -> edited content
let originalPrompts: Map<string, string> = new Map(); // type -> original content (for dirty detection)

// ============================================================================
// POLICY RESOLUTION
// ============================================================================

/** Resolve effective policy for a tool using the layered resolution order */
function resolveEffectivePolicy(toolName: string, toolGroup: string): string {
	// 1. Direct tool override
	if (editToolPolicies[toolName]) return editToolPolicies[toolName];
	// 2. Group-level override (MCP prefix or group name)
	const parts = toolName.split("__");
	if (parts.length >= 3) {
		const serverPrefix = parts.slice(0, 2).join("__");
		if (editToolPolicies[serverPrefix]) return editToolPolicies[serverPrefix];
	}
	if (editToolPolicies[toolGroup]) return editToolPolicies[toolGroup];
	// 3. Tool's own default
	const tool = availableTools.find(t => t.name === toolName);
	if (tool?.grantPolicy) return tool.grantPolicy;
	// 4. Group default from group-policies file
	if (groupPolicies[toolGroup]) return groupPolicies[toolGroup];
	// 5. System fallback
	return "allow";
}

/** Describe where a resolved policy came from */
function policySource(toolName: string, toolGroup: string): string {
	if (editToolPolicies[toolName]) return "role override";
	const parts = toolName.split("__");
	if (parts.length >= 3) {
		const serverPrefix = parts.slice(0, 2).join("__");
		if (editToolPolicies[serverPrefix]) return `from ${serverPrefix}`;
	}
	if (editToolPolicies[toolGroup]) return `from ${toolGroup} role override`;
	const tool = availableTools.find(t => t.name === toolName);
	if (tool?.grantPolicy) return "tool default";
	if (groupPolicies[toolGroup]) return "group default";
	return "system default";
}

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
	editName = role.name;
	editToolPolicies = { ...(role.toolPolicies ?? {}) };
	editTab = "prompt";
	saving = false;
	deleting = false;
	collapsedGroups = new Set<string>();
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
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "role" }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { assistantType: "role" });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create role assistant", msg);
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
		const ok = await updateRole(selectedRole.name, {
			label: editLabel,
			promptTemplate: editPrompt,
			accessory: editAccessory,
			toolPolicies: Object.keys(editToolPolicies).length > 0 ? editToolPolicies : {},
		});

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
			const [r] = await Promise.all([fetchRoles()]);
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
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${selectedRole.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	deleting = true;
	renderApp();
	const ok = await deleteRole(selectedRole.name);
	if (ok) {
		const [r] = await Promise.all([fetchRoles()]);
		roles = r;
		showList();
	} else {
		deleting = false;
		renderApp();
	}
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
		const hasChanges = selectedRole && (
			editLabel !== selectedRole.label ||
			editPrompt !== selectedRole.promptTemplate ||
			editAccessory !== selectedRole.accessory ||
			toolPoliciesChanged ||
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
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${role.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteRole(role.name);
	if (ok) {
		const [r] = await Promise.all([fetchRoles()]);
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

function renderRoleRow(role: RoleData, index: number): TemplateResult {
	const origin = (role as any).origin as ConfigOrigin | undefined;
	const overrides = (role as any).overrides as ConfigOrigin | undefined;
	const inherited = isInherited(origin);
	return html`
		<div class="role-row ${inherited ? "config-item-inherited" : ""}" tabindex="0" role="button" @click=${() => showEdit(role)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(role); } }}>
			${idleBlob(role.accessory ?? "none", 42, index, index)}
			<div class="role-row-info">
				<span class="role-row-label">${role.label}</span>
				<span class="role-row-slug">${role.name} ${renderOriginBadge(origin, overrides)}</span>
			</div>
			<div class="role-row-actions">
				<button class="role-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(role); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="role-row-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDeleteFromList(role); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="roles-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading roles\u2026</span>
			</div>
		`;
	}

	if (roles.length === 0) {
		return html`
			<div class="roles-empty">
				<div class="roles-empty-bobbit">${idleBlob("none", 52)}</div>
				<p class="roles-empty-title">No roles yet</p>
				<p class="roles-empty-desc">Roles give agents a persona, system prompt, and tool restrictions.</p>
				${Button({
					variant: "default",
					onClick: createRoleAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first role</span>`,
				})}
			</div>
		`;
	}

	return html`
		<p class="text-sm text-muted-foreground mb-6" style="max-width: 600px; margin-inline: auto;">Roles define what an agent can do \u2014 its system prompt and which tools it has access to. Bobbit includes built-in roles (coder, reviewer, tester) and you can create custom ones.</p>
		<div class="roles-list">
			${roles.map((role, i) => renderRoleRow(role, i))}
		</div>
	`;
}

// ============================================================================
// RENDER: TOOL ACCESS TAB
// ============================================================================

function handleToolPolicyChange(toolName: string, newPolicy: string): void {
	if (newPolicy) {
		editToolPolicies = { ...editToolPolicies, [toolName]: newPolicy };
	} else {
		const { [toolName]: _, ...rest } = editToolPolicies;
		editToolPolicies = rest;
	}
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

function renderToolAccessTab(): TemplateResult {
	// Group tools by group name
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of availableTools) {
		const g = tool.group || "Other";
		const list = groups.get(g) || [];
		list.push(tool);
		groups.set(g, list);
	}

	const chevronSvg = html`<svg class="roles-access-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

	return html`
		<p class="roles-tools-note">Set per-tool access policies for this role. Tools left at "Use default" inherit from tool, group, or system defaults.</p>
		<div class="roles-access-list">
			${Array.from(groups.entries()).map(([groupName, tools]) => {
				const isCollapsed = collapsedGroups.has(groupName);

				return html`
					<div class="roles-access-group ${isCollapsed ? "collapsed" : ""}">
						<div class="roles-access-group-header" @click=${() => toggleGroup(groupName)}>
							${chevronSvg}
							<span class="roles-access-group-name">${groupName}</span>
							<span class="roles-access-group-count">${tools.length} tool${tools.length !== 1 ? "s" : ""}</span>
							<span class="roles-access-group-policy-label">Group Policy:</span>
							<select class="roles-access-group-select"
								.value=${editToolPolicies[groupName] || ""}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => { e.stopPropagation(); handleToolPolicyChange(groupName, (e.target as HTMLSelectElement).value); }}
							>
								<option value="" ?selected=${!editToolPolicies[groupName]}>Use tool default</option>
								${ROLE_POLICY_OPTIONS.filter(opt => opt.value !== "").map(opt => html`
									<option value=${opt.value} ?selected=${editToolPolicies[groupName] === opt.value}>${opt.label}</option>
								`)}
							</select>
							<span class="roles-access-group-hint">${(() => {
								const groupDefault = groupPolicies[groupName] || "allow";
								const label = POLICY_LABELS[groupDefault] || groupDefault;
								return html`\u2192 ${label} [system default]`;
							})()}</span>
						</div>
						<div class="roles-access-group-items">
							${tools.map(tool => {
								const currentPolicy = editToolPolicies[tool.name] || "";
								const hasGroupOverride = !!editToolPolicies[groupName];
								const defaultLabel = hasGroupOverride ? "Use group role default" : "Use tool default";
								const effective = resolveEffectivePolicy(tool.name, groupName);
								const effectiveLabel = POLICY_LABELS[effective] || effective;
								const source = policySource(tool.name, groupName);
								return html`
									<div class="roles-access-row">
										<span class="roles-access-row-label" title="${tool.description}">${tool.name}</span>
										<select
											class="roles-access-row-select"
											.value=${currentPolicy}
											@change=${(e: Event) => handleToolPolicyChange(tool.name, (e.target as HTMLSelectElement).value)}
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

function renderPromptTab(): TemplateResult {
	return html`
		${editName === "assistant" && assistantPrompts.length > 0 ? html`
			<div class="roles-prompt-tabs">
				<button
					class="roles-prompt-tab ${activePromptTab === "baseline" ? "roles-prompt-tab--active" : ""}"
					@click=${() => { activePromptTab = "baseline"; renderApp(); }}
				>Shared Baseline</button>
				${assistantPrompts.map((p) => html`
					<button
						class="roles-prompt-tab ${activePromptTab === p.type ? "roles-prompt-tab--active" : ""}"
						@click=${() => { activePromptTab = p.type; renderApp(); }}
					>${p.title.replace(" Assistant", "").replace(" Wizard", "")}</button>
				`)}
			</div>
		` : nothing}
		${activePromptTab === "baseline" || editName !== "assistant" || assistantPrompts.length === 0 ? html`
			<textarea
				class="roles-prompt-editor"
				.value=${editPrompt}
				placeholder="Markdown system prompt template. Supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders."
				@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
			></textarea>
		` : html`
			<p class="roles-prompt-hint">This prompt is appended after the shared baseline for ${assistantPrompts.find((p) => p.type === activePromptTab)?.title ?? activePromptTab} sessions.</p>
			<textarea
				class="roles-prompt-editor"
				.value=${editedPrompts.get(activePromptTab) ?? ""}
				@input=${(e: Event) => { editedPrompts.set(activePromptTab, (e.target as HTMLTextAreaElement).value); renderApp(); }}
			></textarea>
		`}
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	return html`
		<div class="roles-edit-container">
			<div class="roles-edit-main">
				<!-- Identity section -->
				<div class="roles-edit-section">
					<div class="flex items-center justify-between">
						<h2 class="roles-section-title">Identity</h2>
						<span class="inline-flex items-center gap-2">
							${renderOriginBadge((selectedRole as any)?.origin, (selectedRole as any)?.overrides)}
							${renderCustomizeRevertButtons()}
						</span>
					</div>
					<div class="roles-identity-row">
						<div class="roles-edit-field">
							<label class="roles-field-label">Id</label>
							<div class="roles-field-readonly">${editName}</div>
						</div>
						<div class="roles-edit-field" style="flex:1;min-width:0;">
							<label class="roles-field-label">Label</label>
							${Input({
								value: editLabel,
								placeholder: "e.g. Documentation Writer",
								onInput: (e: Event) => { editLabel = (e.target as HTMLInputElement).value; renderApp(); },
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
							const selected = editAccessory === accId;
							return html`
								<button
									class="roles-accessory-option ${selected ? "roles-accessory-option--selected" : ""}"
									title="${acc.label}"
									@click=${() => { editAccessory = accId; renderApp(); }}
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
					<button class="roles-tab ${editTab === "prompt" ? "roles-tab--active" : ""}"
						@click=${() => { editTab = "prompt"; renderApp(); }}>Prompt</button>
					<button class="roles-tab ${editTab === "tools" ? "roles-tab--active" : ""}"
						@click=${() => { editTab = "tools"; renderApp(); }}>Tool Access</button>
				</div>

				<!-- Tab content -->
				<div class="roles-tab-content">
					${editTab === "prompt" ? renderPromptTab() : renderToolAccessTab()}
				</div>
			</div>
		</div>
	`;
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
