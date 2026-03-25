import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render, nothing } from "lit";
import { ArrowLeft, ChevronRight, Plus, Trash2 } from "lucide";
import { gatewayFetch, fetchRoles, fetchTools, createRole, updateRole, deleteRole, type RoleData, type ToolInfo } from "./api.js";
import { ACCESSORIES, ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { state, renderApp } from "./state.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

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

let dialogContainer: HTMLDivElement | null = null;

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadData(): Promise<void> {
	loading = true;
	rerender();
	const [r, t] = await Promise.all([fetchRoles(), fetchTools()]);
	roles = r;
	availableTools = t;
	loading = false;
	rerender();
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedRole = null;
	rerender();
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
	rerender();
}

async function createRoleAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	closeDialog();
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
	rerender();

	if (selectedRole) {
		const ok = await updateRole(selectedRole.name, {
			label: editLabel,
			promptTemplate: editPrompt,
			allowedTools: editTools,
			accessory: editAccessory,
		});
		if (ok) {
			await loadData();
			// Stay on edit view but refresh the selected role
			const updated = roles.find((r) => r.name === selectedRole!.name);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	rerender();
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
	rerender();
	const ok = await deleteRole(selectedRole.name);
	if (ok) {
		await loadData();
		showList();
	} else {
		deleting = false;
		rerender();
	}
}

function toggleTool(tool: string): void {
	const idx = editTools.indexOf(tool);
	if (idx >= 0) {
		editTools = editTools.filter((t) => t !== tool);
	} else {
		editTools = [...editTools, tool];
	}
	rerender();
}

function selectAllTools(): void {
	editTools = availableTools.map(t => t.name);
	rerender();
}

function selectNoTools(): void {
	editTools = [];
	rerender();
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderListView() {
	if (loading) {
		return html`<div class="text-center py-8 text-muted-foreground text-sm">Loading…</div>`;
	}

	return html`
		<div class="flex flex-col gap-1">
			${roles.map((role) => {
				const acc = getAccessory(role.accessory);
				const toolText = `${role.allowedTools.length} tool${role.allowedTools.length !== 1 ? "s" : ""}`;
				return html`
					<button
						class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-secondary/70 transition-colors text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
						aria-label="Edit role: ${role.label}"
						title="Edit role: ${role.label}"
						@click=${() => showEdit(role)}
					>
						<span class="flex-shrink-0" style="width:18px;display:flex;align-items:center;justify-content:center;">
							${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory)}
						</span>
						<span class="flex-1 min-w-0">
							<span class="block text-sm font-medium truncate">${role.label}</span>
							<span class="block text-xs text-muted-foreground truncate">${role.name} · ${toolText}</span>
						</span>
						<span class="text-muted-foreground group-hover:text-foreground transition-colors">
							${icon(ChevronRight, "sm")}
						</span>
					</button>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT / CREATE VIEW
// ============================================================================

function renderEditView() {
	const hasChanges = selectedRole && (
		editLabel !== selectedRole.label ||
		editPrompt !== selectedRole.promptTemplate ||
		JSON.stringify(editTools.sort()) !== JSON.stringify([...selectedRole.allowedTools].sort()) ||
		editAccessory !== selectedRole.accessory
	);

	return html`
		<div class="flex flex-col gap-4">
			<!-- Name field -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">Name</label>
				<div class="text-sm text-muted-foreground px-3 py-1.5 bg-secondary/30 rounded-md">${editName}</div>
			</div>

			<!-- Label field -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">Display Label</label>
				${Input({
					value: editLabel,
					placeholder: "e.g. Documentation Writer",
					onInput: (e: Event) => { editLabel = (e.target as HTMLInputElement).value; rerender(); },
				})}
			</div>

			<!-- System prompt -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">System Prompt</label>
				<textarea
					class="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-[13px] outline-none focus:ring-1 focus:ring-ring resize-vertical"
					style="font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; min-height: 140px;"
					.value=${editPrompt}
					placeholder="Markdown system prompt template. Supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders."
					@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
				></textarea>
			</div>

			<!-- Tool selector -->
			<div>
				<div class="flex items-center gap-2 mb-1.5">
					<label class="text-[11px] text-muted-foreground">Allowed Tools</label>
					<span class="text-[10px] text-muted-foreground/60">(empty = all)</span>
					<span class="flex-1"></span>
					<button class="text-[10px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm" title="Select all tools" @click=${selectAllTools}>Select All</button>
					<button class="text-[10px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm" title="Deselect all tools" @click=${selectNoTools}>Select None</button>
				</div>
				<div class="flex flex-wrap gap-1.5">
					${availableTools.map((tool) => {
						const active = editTools.includes(tool.name);
						return html`
							<button
								role="checkbox"
								aria-checked=${active ? "true" : "false"}
								aria-label="${tool.name}"
								title="${tool.description}"
								class="px-2.5 py-1 rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${active
									? "bg-green-900/40 text-green-400 border border-green-700/50"
									: "bg-secondary/50 text-muted-foreground border border-border hover:border-muted-foreground/50"}"
								style="font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;"
								@click=${() => toggleTool(tool.name)}
							>${active ? "✓ " : ""}${tool.name}</button>
						`;
					})}
				</div>
			</div>

			<!-- Accessory selector -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1.5" id="accessory-label">Accessory</label>
				<div class="grid gap-1.5" role="radiogroup" aria-labelledby="accessory-label" style="grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));">
					${ACCESSORY_IDS.map((accId) => {
						const acc = getAccessory(accId);
						const selected = editAccessory === accId;
						return html`
							<button
								role="radio"
								aria-selected=${selected ? "true" : "false"}
								aria-checked=${selected ? "true" : "false"}
								aria-label="${acc.label}"
								title="${acc.label}"
								class="flex flex-col items-center gap-1 py-2 px-1 rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${selected
									? "border-primary bg-secondary"
									: "border-transparent hover:bg-secondary/50"}"
								@click=${() => { editAccessory = accId; rerender(); }}
							>
								<span style="height:20px;display:flex;align-items:center;">
									${accId === "none"
										? html`<span class="text-xs text-muted-foreground">—</span>`
										: statusBobbit("idle", false, undefined, false, false, false, false, accId)}
								</span>
								<span class="text-[10px] ${selected ? "text-foreground" : "text-muted-foreground"}">${acc.label}</span>
							</button>
						`;
					})}
				</div>
			</div>

			<!-- Delete button -->
			<div class="pt-2 border-t border-border/50">
				${Button({
					variant: "ghost" as any,
					onClick: handleDelete,
					disabled: deleting,
					className: "text-destructive hover:text-destructive hover:bg-destructive/10",
					children: html`${icon(Trash2, "sm")} ${deleting ? "Deleting…" : "Delete Role"}`,
				})}
			</div>
		</div>

		<!-- Save button in footer -->
		<div class="flex gap-2 justify-end pt-4">
			${Button({ variant: "ghost", onClick: showList, children: "Cancel" })}
			${Button({
				variant: "default",
				onClick: handleSave,
				disabled: saving || !hasChanges,
				children: saving ? "Saving…" : "Save Changes",
			})}
		</div>
	`;
}

// ============================================================================
// MAIN DIALOG RENDER
// ============================================================================

function rerender(): void {
	if (!dialogContainer) return;

	const isListView = currentView === "list";
	const dialogTitle = isListView ? "Roles" : `Edit: ${selectedRole?.label || ""}`;

	render(
		Dialog({
			isOpen: true,
			onClose: closeDialog,
			width: "min(520px, 92vw)",
			height: "min(680px, 90vh)",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						<div class="flex items-center gap-2 mb-4">
							${!isListView ? html`
								<button
									class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
									aria-label="Back to role list"
									title="Back to role list"
									@click=${showList}
								>${icon(ArrowLeft, "sm")}</button>
							` : nothing}
							<span class="text-base font-semibold flex-1">${dialogTitle}</span>
							${isListView ? html`
								${Button({
									variant: "ghost",
									size: "sm",
									onClick: createRoleAssistantSession,
									children: html`${icon(Plus, "sm")} New Role`,
								})}
							` : nothing}
						</div>
						${isListView ? renderListView() : renderEditView()}
					`,
				})}
			`,
		}),
		dialogContainer,
	);
}

function closeDialog(): void {
	if (dialogContainer) {
		render(html``, dialogContainer);
		dialogContainer.remove();
		dialogContainer = null;
	}
}

// ============================================================================
// ROLE PROPOSAL REVIEW DIALOG
// ============================================================================

export function showRoleEditDialogFromProposal(proposal: { name: string; label: string; prompt: string; tools: string; accessory: string }): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let nameValue = proposal.name;
	let labelValue = proposal.label;
	let promptValue = proposal.prompt;
	let toolsValue = proposal.tools
		? proposal.tools.split(",").map((t) => t.trim()).filter(Boolean)
		: [];
	let accessoryValue = proposal.accessory || "none";
	let isSaving = false;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doSave = async () => {
		isSaving = true;
		rerenderProposal();
		const result = await createRole({
			name: nameValue,
			label: labelValue,
			promptTemplate: promptValue,
			allowedTools: toolsValue,
			accessory: accessoryValue,
		});
		if (result) {
			cleanup();
		} else {
			isSaving = false;
			rerenderProposal();
		}
	};

	const toggleProposalTool = (tool: string) => {
		const idx = toolsValue.indexOf(tool);
		if (idx >= 0) {
			toolsValue = toolsValue.filter((t) => t !== tool);
		} else {
			toolsValue = [...toolsValue, tool];
		}
		rerenderProposal();
	};

	const rerenderProposal = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(520px, 92vw)",
				height: "min(680px, 90vh)",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							<div class="flex items-center gap-2 mb-4">
								<span class="text-base font-semibold flex-1">Review Role</span>
							</div>
							<div class="flex flex-col gap-4">
								<div>
									<label class="block text-[11px] text-muted-foreground mb-1">Name</label>
									${Input({
										value: nameValue,
										placeholder: "my-role (lowercase, hyphens ok)",
										onInput: (e: Event) => { nameValue = (e.target as HTMLInputElement).value; rerenderProposal(); },
									})}
								</div>
								<div>
									<label class="block text-[11px] text-muted-foreground mb-1">Display Label</label>
									${Input({
										value: labelValue,
										placeholder: "e.g. Documentation Writer",
										onInput: (e: Event) => { labelValue = (e.target as HTMLInputElement).value; rerenderProposal(); },
									})}
								</div>
								<div>
									<label class="block text-[11px] text-muted-foreground mb-1">System Prompt</label>
									<textarea
										class="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-[13px] outline-none focus:ring-1 focus:ring-ring resize-vertical"
										style="font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; min-height: 140px;"
										.value=${promptValue}
										@input=${(e: Event) => { promptValue = (e.target as HTMLTextAreaElement).value; }}
									></textarea>
								</div>
								<div>
									<label class="block text-[11px] text-muted-foreground mb-1.5">Allowed Tools</label>
									<div class="flex flex-wrap gap-1.5">
										${availableTools.map((tool) => {
											const active = toolsValue.includes(tool.name);
											return html`
												<button
													role="checkbox"
													aria-checked=${active ? "true" : "false"}
													aria-label="${tool.name}"
													title="${tool.description}"
													class="px-2.5 py-1 rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${active
														? "bg-green-900/40 text-green-400 border border-green-700/50"
														: "bg-secondary/50 text-muted-foreground border border-border hover:border-muted-foreground/50"}"
													style="font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;"
													@click=${() => toggleProposalTool(tool.name)}
												>${active ? "✓ " : ""}${tool.name}</button>
											`;
										})}
									</div>
								</div>
								<div>
									<label class="block text-[11px] text-muted-foreground mb-1.5" id="proposal-accessory-label">Accessory</label>
									<div class="grid gap-1.5" role="radiogroup" aria-labelledby="proposal-accessory-label" style="grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));">
										${ACCESSORY_IDS.map((accId) => {
											const acc = getAccessory(accId);
											const selected = accessoryValue === accId;
											return html`
												<button
													role="radio"
													aria-selected=${selected ? "true" : "false"}
													aria-checked=${selected ? "true" : "false"}
													aria-label="${acc.label}"
													title="${acc.label}"
													class="flex flex-col items-center gap-1 py-2 px-1 rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${selected
														? "border-primary bg-secondary"
														: "border-transparent hover:bg-secondary/50"}"
													@click=${() => { accessoryValue = accId; rerenderProposal(); }}
												>
													<span style="height:20px;display:flex;align-items:center;">
														${accId === "none"
															? html`<span class="text-xs text-muted-foreground">—</span>`
															: statusBobbit("idle", false, undefined, false, false, false, false, accId)}
													</span>
													<span class="text-[10px] ${selected ? "text-foreground" : "text-muted-foreground"}">${acc.label}</span>
												</button>
											`;
										})}
									</div>
								</div>
							</div>
							<div class="flex gap-2 justify-end pt-4">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: doSave,
									disabled: isSaving || !nameValue || !labelValue,
									children: isSaving ? "Creating…" : "Create Role",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	};

	// Ensure we have the tools list loaded
	if (availableTools.length === 0) {
		fetchTools().then((t) => {
			availableTools = t;
			rerenderProposal();
		});
	}

	rerenderProposal();
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function showRoleManagerDialog(): void {
	// Reset state
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;

	dialogContainer = document.createElement("div");
	document.body.appendChild(dialogContainer);

	rerender();
	loadData();
}
