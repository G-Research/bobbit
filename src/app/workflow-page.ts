import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Copy, GripVertical, MessageSquare, Pencil, Plus, Terminal, Trash2 } from "lucide";
import {
	fetchWorkflows,
	createWorkflow,
	updateWorkflow,
	deleteWorkflow,
	cloneWorkflow,
	gatewayFetch,
	type Workflow,
	type WorkflowGate,
	type VerifyStep,
} from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let workflows: Workflow[] = [];
let selectedWorkflow: Workflow | null = null;
let loading = true;
let saving = false;
let isNew = false;

// Edit form state
let editId = "";
let editName = "";
let editDescription = "";
let editGates: WorkflowGate[] = [];

// Collapse/expand state — all gates start collapsed
let expandedGateIndices: Set<number> = new Set();

// Drag-to-reorder state
let dragIndex: number | null = null;
let dropTargetIndex: number | null = null;

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadWorkflowPageData(): Promise<void> {
	currentView = "list";
	selectedWorkflow = null;
	loading = true;
	saving = false;
	isNew = false;
	expandedGateIndices = new Set();
	dragIndex = null;
	dropTargetIndex = null;
	renderApp();
	workflows = await fetchWorkflows();
	loading = false;
	renderApp();
}

export function clearWorkflowPageState(): void {
	currentView = "list";
	selectedWorkflow = null;
	loading = true;
	saving = false;
	isNew = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedWorkflow = null;
	isNew = false;
	setHashRoute("workflows");
}

function showEdit(workflow: Workflow): void {
	currentView = "edit";
	selectedWorkflow = workflow;
	isNew = false;
	editId = workflow.id;
	editName = workflow.name;
	editDescription = workflow.description;
	editGates = workflow.gates.map((g) => ({ ...g, dependsOn: [...g.dependsOn], verify: g.verify ? g.verify.map(v => ({ ...v })) : undefined, metadata: g.metadata ? { ...g.metadata } : undefined }));
	saving = false;
	expandedGateIndices = new Set();
	setHashRoute("workflow-edit", workflow.id);
}

function showNewEdit(): void {
	currentView = "edit";
	selectedWorkflow = null;
	isNew = true;
	editId = "";
	editName = "";
	editDescription = "";
	editGates = [];
	saving = false;
	expandedGateIndices = new Set();
	renderApp();
}

export function navigateToWorkflowEdit(workflowId: string): void {
	const wf = workflows.find((w) => w.id === workflowId);
	if (wf) {
		showEdit(wf);
	} else {
		currentView = "list";
		selectedWorkflow = null;
	}
	renderApp();
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	if (isNew) {
		const result = await createWorkflow({
			id: editId,
			name: editName,
			description: editDescription,
			gates: editGates,
		});
		if (result) {
			workflows = await fetchWorkflows();
			showEdit(result);
			return;
		}
	} else if (selectedWorkflow) {
		const ok = await updateWorkflow(selectedWorkflow.id, {
			name: editName,
			description: editDescription,
			gates: editGates,
		});
		if (ok) {
			workflows = await fetchWorkflows();
			const updated = workflows.find((w) => w.id === selectedWorkflow!.id);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(workflow: Workflow): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Workflow",
		`Are you sure you want to delete "${workflow.name}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteWorkflow(workflow.id);
	if (ok) {
		workflows = await fetchWorkflows();
		if (selectedWorkflow?.id === workflow.id) {
			showList();
		}
		renderApp();
	}
}

async function handleClone(workflow: Workflow): Promise<void> {
	const result = await cloneWorkflow(workflow.id);
	if (result) {
		workflows = await fetchWorkflows();
		showEdit(result);
	}
}

function addGate(): void {
	editGates = [...editGates, {
		id: "",
		name: "",
		dependsOn: [],
	}];
	// Expand the newly added gate
	expandedGateIndices.add(editGates.length - 1);
	renderApp();
}

function removeGate(index: number): void {
	editGates = editGates.filter((_, i) => i !== index);
	// Fix expanded indices after removal
	const newExpanded = new Set<number>();
	for (const idx of expandedGateIndices) {
		if (idx < index) newExpanded.add(idx);
		else if (idx > index) newExpanded.add(idx - 1);
	}
	expandedGateIndices = newExpanded;
	renderApp();
}

function updateGateField(index: number, field: string, value: any): void {
	editGates = editGates.map((g, i) => i === index ? { ...g, [field]: value } : g);
	renderApp();
}

function toggleGateExpand(index: number): void {
	if (expandedGateIndices.has(index)) {
		expandedGateIndices.delete(index);
	} else {
		expandedGateIndices.add(index);
	}
	renderApp();
}

// ============================================================================
// DRAG-TO-REORDER
// ============================================================================

function moveGate(fromIdx: number, toIdx: number): void {
	if (fromIdx === toIdx) return;
	const newGates = [...editGates];
	const [moved] = newGates.splice(fromIdx, 1);
	newGates.splice(toIdx, 0, moved);
	editGates = newGates;

	// Remap expanded indices
	const remap = (oldIdx: number): number => {
		if (oldIdx === fromIdx) return toIdx;
		if (fromIdx < toIdx) {
			if (oldIdx > fromIdx && oldIdx <= toIdx) return oldIdx - 1;
		} else {
			if (oldIdx >= toIdx && oldIdx < fromIdx) return oldIdx + 1;
		}
		return oldIdx;
	};
	const newExpanded = new Set<number>();
	for (const idx of expandedGateIndices) newExpanded.add(remap(idx));
	expandedGateIndices = newExpanded;

	renderApp();
}

function handleDragStart(e: DragEvent, index: number): void {
	dragIndex = index;
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(index));
	}
	renderApp();
}

function handleDragOver(e: DragEvent, index: number): void {
	e.preventDefault();
	if (dragIndex === null) return;
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

	// Determine if drop should be before or after this card
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const midY = rect.top + rect.height / 2;
	const newTarget = e.clientY < midY ? index : index + 1;

	if (newTarget !== dropTargetIndex) {
		dropTargetIndex = newTarget;
		renderApp();
	}
}

function handleDrop(e: DragEvent): void {
	e.preventDefault();
	if (dragIndex !== null && dropTargetIndex !== null) {
		const to = dropTargetIndex > dragIndex ? dropTargetIndex - 1 : dropTargetIndex;
		moveGate(dragIndex, to);
	}
	dragIndex = null;
	dropTargetIndex = null;
	renderApp();
}

function handleDragEnd(): void {
	dragIndex = null;
	dropTargetIndex = null;
	renderApp();
}

// ============================================================================
// TOUCH DRAG-TO-REORDER
// ============================================================================

let touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartY = 0;
let touchDragging = false;

function cancelTouchDrag(): void {
	if (touchLongPressTimer) { clearTimeout(touchLongPressTimer); touchLongPressTimer = null; }
	if (touchDragging || dragIndex !== null) {
		touchDragging = false;
		dragIndex = null;
		dropTargetIndex = null;
		renderApp();
	}
}

/** Find which gate card index the touch Y coordinate is over */
function touchDropTarget(clientY: number): number | null {
	const cards = document.querySelectorAll(".wf-gate-card");
	for (let i = 0; i < cards.length; i++) {
		const rect = cards[i].getBoundingClientRect();
		if (clientY < rect.top + rect.height / 2) return i;
	}
	return cards.length;
}

function startTouchDrag(index: number, clientY: number): void {
	touchDragging = true;
	dragIndex = index;
	touchStartY = clientY;
	dropTargetIndex = index;
	renderApp();
}

/** Grip: immediate drag on touch */
function handleGripTouchStart(e: TouchEvent, index: number): void {
	e.preventDefault(); // prevent scroll
	e.stopPropagation();
	const touch = e.touches[0];
	startTouchDrag(index, touch.clientY);
}

/** Header: long-press to drag */
function handleHeaderTouchStart(e: TouchEvent, index: number): void {
	const touch = e.touches[0];
	touchStartY = touch.clientY;
	const startX = touch.clientX;
	touchLongPressTimer = setTimeout(() => {
		touchLongPressTimer = null;
		startTouchDrag(index, touch.clientY);
	}, 500);
	// Cancel on significant movement
	const moveCancel = (ev: TouchEvent) => {
		const t = ev.touches[0];
		if (Math.abs(t.clientY - touchStartY) > 10 || Math.abs(t.clientX - startX) > 10) {
			if (touchLongPressTimer) { clearTimeout(touchLongPressTimer); touchLongPressTimer = null; }
			document.removeEventListener("touchmove", moveCancel);
		}
	};
	document.addEventListener("touchmove", moveCancel, { passive: true });
}

function handleTouchMove(e: TouchEvent): void {
	if (!touchDragging || dragIndex === null) return;
	e.preventDefault(); // prevent scroll while dragging
	const touch = e.touches[0];
	const target = touchDropTarget(touch.clientY);
	if (target !== null && target !== dropTargetIndex) {
		dropTargetIndex = target;
		renderApp();
	}
}

function handleTouchEnd(): void {
	if (touchLongPressTimer) { clearTimeout(touchLongPressTimer); touchLongPressTimer = null; }
	if (!touchDragging || dragIndex === null) return;
	if (dragIndex !== null && dropTargetIndex !== null) {
		const to = dropTargetIndex > dragIndex ? dropTargetIndex - 1 : dropTargetIndex;
		moveGate(dragIndex, to);
	}
	touchDragging = false;
	dragIndex = null;
	dropTargetIndex = null;
	renderApp();
}

// ============================================================================
// HELPERS
// ============================================================================

function getVerifySummary(gate: WorkflowGate): string {
	const steps = gate.verify || [];
	if (steps.length === 0) return "";
	const cmdCount = steps.filter(s => s.type === "command").length;
	const reviewCount = steps.filter(s => s.type === "llm-review").length;
	const parts: string[] = [];
	if (cmdCount > 0) parts.push(`${cmdCount} cmd`);
	if (reviewCount > 0) parts.push(`${reviewCount} review`);
	return parts.join(", ");
}

// ============================================================================
// RENDER: VERIFY STEP EDITOR
// ============================================================================

function renderVerifyStepEditor(gate: WorkflowGate, gateIdx: number, step: VerifyStep, stepIdx: number): TemplateResult {
	const typeIcon = step.type === "command" ? Terminal : MessageSquare;
	return html`
		<div class="wf-verification-step">
			<div class="wf-vstep-header">
				<span class="wf-verify-type-icon">${icon(typeIcon, "sm")}</span>
				<input class="wf-input wf-vstep-name" .value=${step.name || ""} placeholder="Step name"
					@input=${(e: Event) => {
						const steps = [...(gate.verify || [])];
						steps[stepIdx] = { ...steps[stepIdx], name: (e.target as HTMLInputElement).value };
						updateGateField(gateIdx, "verify", steps);
					}} />
				<select class="wf-select wf-vstep-type" .value=${step.type || "command"}
					@change=${(e: Event) => {
						const steps = [...(gate.verify || [])];
						steps[stepIdx] = { ...steps[stepIdx], type: (e.target as HTMLSelectElement).value as "command" | "llm-review" };
						updateGateField(gateIdx, "verify", steps);
					}}>
					<option value="command" ?selected=${step.type === "command"}>command</option>
					<option value="llm-review" ?selected=${step.type === "llm-review"}>llm-review</option>
				</select>
				${step.type === "command" ? html`
					<select class="wf-select wf-vstep-expect" .value=${step.expect || "success"}
						@change=${(e: Event) => {
							const steps = [...(gate.verify || [])];
							steps[stepIdx] = { ...steps[stepIdx], expect: (e.target as HTMLSelectElement).value as "success" | "failure" };
							updateGateField(gateIdx, "verify", steps);
						}}>
						<option value="success" ?selected=${step.expect !== "failure"}>expect: success</option>
						<option value="failure" ?selected=${step.expect === "failure"}>expect: failure</option>
					</select>
				` : nothing}
				<button class="wf-criteria-remove" title="Remove verification step" @click=${(e: Event) => {
					e.stopPropagation();
					const steps = (gate.verify || []).filter((_: any, i: number) => i !== stepIdx);
					updateGateField(gateIdx, "verify", steps);
				}}>${icon(Trash2, "sm")}</button>
			</div>
			${step.type === "command" ? html`
				<input class="wf-input" .value=${step.run || ""} placeholder="Command to run..."
					@input=${(e: Event) => {
						const steps = [...(gate.verify || [])];
						steps[stepIdx] = { ...steps[stepIdx], run: (e.target as HTMLInputElement).value };
						updateGateField(gateIdx, "verify", steps);
					}} />
				<div class="wf-field-hint">Variables: {{branch}}, {{master}}, {{cwd}}, {{project.key}}, {{agent.key}}, {{gate_id.meta.key}}</div>
			` : html`
				<textarea class="wf-textarea" .value=${step.prompt || ""} placeholder="Review prompt..."
					@input=${(e: Event) => {
						const steps = [...(gate.verify || [])];
						steps[stepIdx] = { ...steps[stepIdx], prompt: (e.target as HTMLTextAreaElement).value };
						updateGateField(gateIdx, "verify", steps);
					}}></textarea>
			`}
		</div>
	`;
}

// ============================================================================
// WORKFLOW ASSISTANT SESSION
// ============================================================================

async function createWorkflowAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "workflow" }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { assistantType: "workflow" });
	} catch (err) {
		console.error("Failed to create workflow assistant session:", err);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit") {
		const title = isNew ? "New Workflow" : selectedWorkflow?.name || "Edit";
		return html`
			<div class="wf-nav">
				<div class="wf-nav-left">
					<button class="wf-back" @click=${showList} title="Back to workflows">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="wf-title-group">
						<span class="wf-breadcrumb" @click=${showList}>Workflows</span>
						<span class="wf-breadcrumb-sep">/</span>
						<h1 class="wf-title">${title}</h1>
					</div>
				</div>
				<div class="wf-nav-right">
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: createWorkflowAssistantSession,
						children: html`<span class="inline-flex items-center gap-1.5">${icon(MessageSquare, "sm")} Assistant</span>`,
					})}
					${!isNew && selectedWorkflow ? html`
						${Button({
							variant: "ghost" as any,
							size: "sm",
							onClick: () => handleDelete(selectedWorkflow!),
							className: "text-destructive hover:text-destructive hover:bg-destructive/10",
							children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} Delete</span>`,
						})}
					` : nothing}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || (!editId.trim() && isNew) || !editName.trim(),
						children: saving ? "Saving\u2026" : "Save",
					})}
				</div>
			</div>
		`;
	}

	return html`
		<div class="wf-nav">
			<div class="wf-nav-left">
				<button class="wf-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="wf-title">Workflows</h1>
			</div>
			<div class="wf-nav-right">
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: createWorkflowAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(MessageSquare, "sm")} Workflow Assistant</span>`,
				})}
				${Button({
					variant: "default",
					size: "sm",
					onClick: showNewEdit,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Workflow</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderWorkflowRow(wf: Workflow): TemplateResult {
	return html`
		<div class="wf-row" tabindex="0" role="button"
			@click=${() => showEdit(wf)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(wf); } }}>
			<div class="wf-row-info">
				<span class="wf-row-name">${wf.name}</span>
				<span class="wf-row-desc">${wf.description}</span>
			</div>
			<div class="wf-row-badges">
				<span class="wf-badge">${wf.gates.length} gate${wf.gates.length !== 1 ? "s" : ""}</span>
			</div>
			<div class="wf-row-actions">
				<button class="wf-action-btn" @click=${(e: Event) => { e.stopPropagation(); handleClone(wf); }} title="Clone">
					${icon(Copy, "sm")}
				</button>
				<button class="wf-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(wf); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="wf-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDelete(wf); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="wf-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading workflows\u2026</span>
			</div>
		`;
	}

	if (workflows.length === 0) {
		return html`
			<div class="wf-empty">
				<p class="wf-empty-title">No workflows yet</p>
				<p class="wf-empty-desc">Workflows define gates — checkpoints a goal must pass through, with dependency ordering and automated verification.</p>
				${Button({
					variant: "default",
					onClick: showNewEdit,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first workflow</span>`,
				})}
			</div>
		`;
	}

	return html`
		<p class="text-sm text-muted-foreground mb-3">Workflows define the stages (gates) a goal goes through \u2014 like design \u2192 implement \u2192 test \u2192 review. They ensure quality by enforcing order and verification.</p>
		<div class="wf-list">
			${workflows.map((wf) => renderWorkflowRow(wf))}
		</div>
	`;
}

// ============================================================================
// RENDER: GATE EDITOR (collapsible card)
// ============================================================================

function renderGateEditor(gate: WorkflowGate, idx: number): TemplateResult {
	const otherIds = editGates.filter((_, i) => i !== idx).map((g) => g.id).filter(Boolean);
	const isExpanded = expandedGateIndices.has(idx);
	const isDragging = dragIndex === idx;
	const verifySummary = getVerifySummary(gate);
	const verifyCount = (gate.verify || []).length;

	return html`
		${dropTargetIndex === idx && dragIndex !== null && dragIndex !== idx ? html`<div class="wf-drop-indicator"></div>` : nothing}
		<div class="wf-gate-card ${isExpanded ? "expanded" : ""} ${isDragging ? "dragging" : ""}">
			<div class="wf-gate-header"
				draggable="true"
				@dragstart=${(e: DragEvent) => handleDragStart(e, idx)}
				@dragover=${(e: DragEvent) => handleDragOver(e, idx)}
				@drop=${handleDrop}
				@dragend=${handleDragEnd}
				@touchstart=${(e: TouchEvent) => handleHeaderTouchStart(e, idx)}
				@touchmove=${handleTouchMove}
				@touchend=${handleTouchEnd}
				@touchcancel=${cancelTouchDrag}
				@click=${() => toggleGateExpand(idx)}>
				<span class="wf-gate-grip"
					@touchstart=${(e: TouchEvent) => handleGripTouchStart(e, idx)}>${icon(GripVertical, "sm")}</span>
				<span class="wf-gate-idx">${idx + 1}</span>
				<code class="wf-gate-id">${gate.id || "(no id)"}</code>
				<span class="wf-gate-name">${gate.name || ""}</span>
				${gate.dependsOn.length > 0 ? html`
					<span class="wf-gate-deps-desktop">
						<span class="wf-gate-dep-arrow">\u2190</span>
						${gate.dependsOn.map(d => html`<span class="wf-dep-chip">${d}</span>`)}
					</span>
					<span class="wf-gate-deps-mobile">
						<span class="wf-gate-pill">${gate.dependsOn.length} dep${gate.dependsOn.length !== 1 ? "s" : ""}</span>
					</span>
				` : nothing}
				${verifySummary ? html`<span class="wf-gate-pill">${verifySummary}</span>` : nothing}
				<span class="wf-gate-chevron">\u25B8</span>
				<button class="wf-gate-delete" @click=${(e: Event) => { e.stopPropagation(); removeGate(idx); }} title="Remove gate">${icon(Trash2, "sm")}</button>
			</div>

			<div class="wf-gate-body">
				<div class="wf-gate-body-inner">
					<div class="wf-field-row">
						<div class="wf-field" style="flex:0 0 160px;">
							<label class="wf-field-label">ID</label>
							<input class="wf-input" .value=${gate.id} placeholder="e.g. issue-analysis"
								@input=${(e: Event) => updateGateField(idx, "id", (e.target as HTMLInputElement).value)} />
						</div>
						<div class="wf-field" style="flex:1;min-width:0;">
							<label class="wf-field-label">Name</label>
							<input class="wf-input" .value=${gate.name} placeholder="Display name"
								@input=${(e: Event) => updateGateField(idx, "name", (e.target as HTMLInputElement).value)} />
						</div>
					</div>

					<div class="wf-field-row">
						<div class="wf-field" style="flex:1;">
							<label class="wf-toggle-row">
								<input type="checkbox" class="toggle-switch" .checked=${gate.content === true}
									@change=${(e: Event) => updateGateField(idx, "content", (e.target as HTMLInputElement).checked || undefined)} />
								<span>Content gate (accepts markdown content)</span>
							</label>
						</div>
						<div class="wf-field" style="flex:1;">
							<label class="wf-toggle-row">
								<input type="checkbox" class="toggle-switch" .checked=${gate.injectDownstream === true}
									@change=${(e: Event) => updateGateField(idx, "injectDownstream", (e.target as HTMLInputElement).checked || undefined)} />
								<span>Inject content downstream</span>
							</label>
						</div>
					</div>

					<div class="wf-field">
						<label class="wf-section-title">Depends On</label>
						<div class="wf-dep-list">
							${otherIds.length > 0 ? otherIds.map((depId) => {
								const checked = gate.dependsOn.includes(depId);
								return html`
									<button class="wf-dep-toggle-chip ${checked ? "wf-dep-toggle-chip--active" : ""}"
										title="Toggle dependency on ${depId}"
										@click=${() => {
											const newDeps = checked ? gate.dependsOn.filter((d) => d !== depId) : [...gate.dependsOn, depId];
											updateGateField(idx, "dependsOn", newDeps);
										}}>
										${depId}
									</button>
								`;
							}) : html`<span class="wf-dep-none">No other gates to depend on</span>`}
						</div>
					</div>

					<div class="wf-field">
						<span class="wf-verify-label">Verification Steps (${verifyCount})</span>
						<div class="wf-verification-steps">
							${(gate.verify || []).map((step, si) => renderVerifyStepEditor(gate, idx, step, si))}
							<button class="wf-criteria-add-btn" title="Add verification step" @click=${(e: Event) => {
								e.stopPropagation();
								const steps = [...(gate.verify || []), { name: "", type: "command" as const, run: "" }];
								updateGateField(idx, "verify", steps);
							}}>Add Step</button>
						</div>
					</div>
				</div>
			</div>
		</div>
		${dropTargetIndex === editGates.length && idx === editGates.length - 1 && dragIndex !== null ? html`<div class="wf-drop-indicator"></div>` : nothing}
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	return html`
		<div class="wf-edit-container">
			<div class="wf-edit-identity">
				<div class="wf-field-row">
					${isNew ? html`
						<div class="wf-field" style="flex:0 0 200px;">
							<label class="wf-field-label">ID</label>
							<input class="wf-input" .value=${editId} placeholder="e.g. bug-fix"
								@input=${(e: Event) => { editId = (e.target as HTMLInputElement).value; renderApp(); }} />
						</div>
					` : html`
						<div class="wf-field" style="flex:0 0 200px;">
							<label class="wf-field-label">ID</label>
							<div class="wf-field-readonly">${editId}</div>
						</div>
					`}
					<div class="wf-field" style="flex:1;min-width:0;">
						<label class="wf-field-label">Name</label>
						<input class="wf-input" .value=${editName} placeholder="Workflow name"
							@input=${(e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); }} />
					</div>
				</div>
				<div class="wf-field">
					<label class="wf-field-label">Description</label>
					<textarea class="wf-textarea" .value=${editDescription} placeholder="What this workflow does"
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; }}></textarea>
				</div>
			</div>

			<div class="wf-artifacts-header">
				<h2 class="wf-section-title">Gates (${editGates.length})</h2>
				${Button({
					variant: "ghost" as any,
					size: "sm",
					onClick: addGate,
					children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add Gate</span>`,
				})}
			</div>

			<div class="wf-artifacts-list">
				${editGates.map((gate, idx) => renderGateEditor(gate, idx))}
				${editGates.length === 0 ? html`
					<div class="wf-empty-artifacts">
						<p>No gates defined yet.</p>
						${Button({
							variant: "default",
							size: "sm",
							onClick: addGate,
							children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add First Gate</span>`,
						})}
					</div>
				` : nothing}
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderWorkflowPage(): TemplateResult {
	return html`
		<div class="wf-container">
			${renderNavBar()}
			<div class="wf-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
