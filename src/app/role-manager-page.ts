import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import { fetchRoles, fetchTools, updateRole, deleteRole, gatewayFetch, fetchAssistantPrompts, updateAssistantPrompt, type RoleData, type ToolInfo, type AssistantPromptInfo } from "./api.js";
import { ACCESSORY_IDS, getAccessory } from "./session-colors.js";
import { renderIdleBlobCanvas } from "../ui/bobbit-render.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// HELPERS
// ============================================================================

/** Render an idle in-chat blob with the given accessory in a self-contained box.
 *
 *  The blob's CSS assumes chat context: the sprite has margin 8px 18px 28px 18px,
 *  the blob container has margin-bottom:-24px and overflow:visible. To render it
 *  outside chat we use a CSS class (.bobbit-blob--inline) that resets these
 *  properties, added via role-manager.css.
 */
function idleBlob(accId: string, size = 40, hueIndex = 0, phaseIndex = 0): TemplateResult {
	const accClass = accId && accId !== "none"
		? `bobbit-${accId === "crown" ? "crowned" : accId}`
		: "";
	return renderIdleBlobCanvas({ accId, accClass, size, hueIndex, phaseIndex });
}

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
let editTools: string[] = [];
let editAccessory = "none";
let editName = "";

let saving = false;
let deleting = false;

// Assistant sub-prompt state
let assistantPrompts: AssistantPromptInfo[] = [];
let activePromptTab: string = "baseline"; // "baseline" or assistant type key
let editedPrompts: Map<string, string> = new Map(); // type -> edited content
let originalPrompts: Map<string, string> = new Map(); // type -> original content (for dirty detection)

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadRolePageData(): Promise<void> {
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	const [r, t] = await Promise.all([fetchRoles(), fetchTools()]);
	roles = r;
	availableTools = t;
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

function showEdit(role: RoleData): void {
	currentView = "edit";
	selectedRole = role;
	editLabel = role.label;
	editPrompt = role.promptTemplate;
	editTools = [...role.allowedTools];
	editAccessory = role.accessory;
	editName = role.name;
	saving = false;
	deleting = false;
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
	setHashRoute("role-edit", role.name);
}

/** Called by the main router when navigating to #/roles/:name */
export function navigateToRoleEdit(roleName: string): void {
	const role = roles.find((r) => r.name === roleName);
	if (role) {
		currentView = "edit";
		selectedRole = role;
		editLabel = role.label;
		editPrompt = role.promptTemplate;
		editTools = [...role.allowedTools];
		editAccessory = role.accessory;
		editName = role.name;
		saving = false;
		deleting = false;
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
			allowedTools: editTools,
			accessory: editAccessory,
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

function toggleTool(tool: string): void {
	const idx = editTools.indexOf(tool);
	if (idx >= 0) {
		editTools = editTools.filter((t) => t !== tool);
	} else {
		editTools = [...editTools, tool];
	}
	renderApp();
}

function toggleToolGroup(group: string): void {
	const groupNames = availableTools.filter(t => t.group === group).map(t => t.name);
	const allSelected = groupNames.every(n => editTools.includes(n));
	if (allSelected) {
		editTools = editTools.filter(t => !groupNames.includes(t));
	} else {
		const toAdd = groupNames.filter(n => !editTools.includes(n));
		editTools = [...editTools, ...toAdd];
	}
	renderApp();
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView !== "list" && selectedRole) {
		const subPromptsDirty = Array.from(editedPrompts.entries()).some(
			([type, content]) => content !== (originalPrompts.get(type) ?? ""),
		);
		const hasChanges = selectedRole && (
			editLabel !== selectedRole.label ||
			editPrompt !== selectedRole.promptTemplate ||
			JSON.stringify([...editTools].sort()) !== JSON.stringify([...selectedRole.allowedTools].sort()) ||
			editAccessory !== selectedRole.accessory ||
			subPromptsDirty
		);
		// Edit view: back goes to roles list, breadcrumb shows hierarchy, actions on right
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

function renderRoleRow(role: RoleData, index: number): TemplateResult {
	return html`
		<div class="role-row" tabindex="0" role="button" @click=${() => showEdit(role)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(role); } }}>
			${idleBlob(role.accessory ?? "none", 42, index, index)}
			<div class="role-row-info">
				<span class="role-row-label">${role.label}</span>
				<span class="role-row-slug">${role.name}</span>
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
		<p class="text-sm text-muted-foreground mb-3" style="max-width: 600px; margin: 0 auto;">Roles define what an agent can do \u2014 its system prompt and which tools it has access to. Bobbit includes built-in roles (coder, reviewer, tester) and you can create custom ones.</p>
		<div class="roles-list">
			${roles.map((role, i) => renderRoleRow(role, i))}
		</div>
	`;
}

// ============================================================================
// RENDER: TOOL GROUPS
// ============================================================================

function renderToolGroups(): TemplateResult {
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of availableTools) {
		const list = groups.get(tool.group) || [];
		list.push(tool);
		groups.set(tool.group, list);
	}

	return html`
		<div class="roles-tool-groups">
			${Array.from(groups.entries()).map(([group, tools]) => {
				const allSelected = tools.every(t => editTools.includes(t.name));
				const someSelected = tools.some(t => editTools.includes(t.name));
				return html`
					<div class="roles-tool-group">
						<button class="roles-tool-group-header" title="Toggle ${group} tools" @click=${() => toggleToolGroup(group)}>
							<span class="roles-tool-group-check ${allSelected ? "checked" : someSelected ? "partial" : ""}">
								${allSelected ? "\u2713" : someSelected ? "\u2013" : ""}
							</span>
							<span class="roles-tool-group-name">${group}</span>
							<span class="roles-tool-group-count">${tools.filter(t => editTools.includes(t.name)).length}/${tools.length}</span>
						</button>
						<div class="roles-tool-group-items">
							${tools.map(tool => {
								const active = editTools.includes(tool.name);
								return html`
									<button
										class="roles-tool-chip ${active ? "roles-tool-chip--active" : ""}"
										title="${tool.description}"
										@click=${() => toggleTool(tool.name)}
									>${tool.name}</button>
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
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	return html`
		<div class="roles-edit-container">
			<div class="roles-edit-main">
				<!-- Identity section -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">Identity</h2>
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
										${accId === "none"
											? html`<span class="text-xs text-muted-foreground">\u2014</span>`
											: idleBlob(accId, 42, i, i)}
									</span>
									<span class="roles-accessory-label">${acc.label}</span>
								</button>
							`;
						})}
					</div>
				</div>

				<!-- System prompt section -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">System Prompt</h2>
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
				</div>
			</div>

			<!-- Right sidebar -->
			<div class="roles-edit-sidebar">
				<!-- Tools section -->
				<div class="roles-edit-section">
					<div class="roles-tools-top">
						<h2 class="roles-section-title">Tool Access</h2>
					</div>
					<p class="roles-tools-note">${editTools.length} of ${availableTools.length} tools enabled</p>
					${renderToolGroups()}
				</div>


			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderRoleManagerPage(): TemplateResult {
	return html`
		<div class="roles-container">
			${renderNavBar()}
			<div class="roles-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
