// CSS for this page (and the project-proposal preview pane that reuses
// .wf-* classes) is eagerly imported from main.ts so it is available even
// when this lazy page module has not been loaded yet.
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, GripVertical, MessageSquare, Pencil, Plus, Sparkles, Terminal, TestTube, Trash2 } from "lucide";
import {
	createWorkflow,
	updateWorkflow,
	deleteWorkflow,
	gatewayFetch,
	type Workflow,
	type WorkflowGate,
	type VerifyStep,
} from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { type ConfigOrigin, getConfigScope, setConfigScope, getConfigProjectId, renderOriginBadge, renderConfigScopeRow, revertOverride } from "./config-scope.js";

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

// Controlled mode — when set, the editor renders without save/delete/scope
// chrome and notifies the controller via onChange instead of touching the
// project workflow store. Used by embeds such as the goal-proposal modal.
type EditorScope = "project" | "goal-draft";
type EditorController = {
	scope: EditorScope;
	workflowKey: string;
	onChange: (wf: Workflow) => void;
	// When true the shared editor renderer outputs the read-only
	// inspector view: inputs disabled, drag/delete/add affordances
	// hidden, save chrome suppressed. The inspector consumer never
	// receives onChange calls (controller.onChange is wired to noop).
	readOnly?: boolean;
};

function isReadOnly(): boolean {
	return editorController?.readOnly === true;
}
let editorController: EditorController | null = null;

// Collapse/expand state — all gates start collapsed
let expandedGateIndices: Set<number> = new Set();

let expandedVStepKeys: Set<string> = new Set();

// Drag-to-reorder state (gates)
let dragIndex: number | null = null;
let dropTargetIndex: number | null = null;

// Drag-to-reorder state (verification steps — separate from gate drag)
let vstepDragGateIdx: number | null = null;
let vstepDragStepIdx: number | null = null;
let vstepDropTarget: { phase: number; position: number } | null = null;

// Empty phases tracking (gateIdx → set of empty phase numbers)
let emptyPhases: Map<number, Set<number>> = new Map();

// ============================================================================
// DATA LOADING
// ============================================================================

async function fetchWorkflowsScoped(): Promise<Workflow[]> {
	const projectId = getConfigProjectId();
	const url = projectId ? `/api/workflows?projectId=${encodeURIComponent(projectId)}` : "/api/workflows";
	try {
		const res = await gatewayFetch(url);
		if (!res.ok) return [];
		const data = await res.json();
		return data.workflows || [];
	} catch {
		return [];
	}
}

export async function loadWorkflowPageData(): Promise<void> {
	currentView = "list";
	selectedWorkflow = null;
	loading = true;
	saving = false;
	isNew = false;
	expandedGateIndices = new Set();
	expandedVStepKeys = new Set();
	dragIndex = null;
	dropTargetIndex = null;
	vstepDragGateIdx = null;
	vstepDragStepIdx = null;
	vstepDropTarget = null;
	emptyPhases = new Map();
	// Workflows are project-scoped only — if the shared config scope is
	// "system", auto-switch to the first project before fetching. Other
	// config pages keep their System tab.
	if (getConfigScope() === "system") {
		const firstProject = (state.projects || [])[0];
		if (firstProject) setConfigScope(firstProject.id);
	}
	renderApp();
	workflows = await fetchWorkflowsScoped();
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
	editorController = null;
	currentView = "edit";
	selectedWorkflow = workflow;
	isNew = false;
	editId = workflow.id;
	editName = workflow.name;
	editDescription = workflow.description;
	editGates = workflow.gates.map((g) => ({ ...g, dependsOn: [...g.dependsOn], verify: g.verify ? g.verify.map(v => ({ ...v })) : undefined, metadata: g.metadata ? { ...g.metadata } : undefined }));
	saving = false;
	expandedGateIndices = new Set();
	expandedVStepKeys = new Set();
	setHashRoute("workflow-edit", workflow.id);
}

function showNewEdit(): void {
	editorController = null;
	currentView = "edit";
	selectedWorkflow = null;
	isNew = true;
	editId = "";
	editName = "";
	editDescription = "";
	editGates = [];
	saving = false;
	expandedGateIndices = new Set();
	expandedVStepKeys = new Set();
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

// ============================================================================
// PHASE HELPERS
// ============================================================================

function groupStepsByPhase(steps: VerifyStep[]): Map<number, { step: VerifyStep; originalIndex: number }[]> {
	const groups = new Map<number, { step: VerifyStep; originalIndex: number }[]>();
	steps.forEach((step, idx) => {
		const phase = step.phase ?? 0;
		if (!groups.has(phase)) groups.set(phase, []);
		groups.get(phase)!.push({ step, originalIndex: idx });
	});
	return new Map([...groups.entries()].sort((a, b) => a[0] - b[0]));
}

function compactPhases(gates: WorkflowGate[]): WorkflowGate[] {
	return gates.map(g => {
		if (!g.verify?.length) return g;
		const phases = [...new Set(g.verify.map(s => s.phase ?? 0))].sort((a, b) => a - b);
		const remap = new Map(phases.map((p, i) => [p, i]));
		return {
			...g,
			verify: g.verify.map(s => ({ ...s, phase: remap.get(s.phase ?? 0) ?? 0 })),
		};
	});
}

function getAllPhaseNumbers(gateIdx: number): number[] {
	const steps = editGates[gateIdx].verify || [];
	const stepPhases = new Set(steps.map(s => s.phase ?? 0));
	const empty = emptyPhases.get(gateIdx) || new Set();
	for (const p of empty) stepPhases.add(p);
	return [...stepPhases].sort((a, b) => a - b);
}

function addPhase(gateIdx: number): void {
	const phases = getAllPhaseNumbers(gateIdx);
	const next = phases.length > 0 ? Math.max(...phases) + 1 : 1;
	if (!emptyPhases.has(gateIdx)) emptyPhases.set(gateIdx, new Set());
	emptyPhases.get(gateIdx)!.add(next);
	renderApp();
}

function removeEmptyPhase(gateIdx: number, phase: number): void {
	const ep = emptyPhases.get(gateIdx);
	if (ep) { ep.delete(phase); }
	renderApp();
}

// ============================================================================
// VSTEP DRAG-AND-DROP
// ============================================================================

function moveVerifyStep(gateIdx: number, fromStepIdx: number, toPhase: number, toPosition: number): void {
	const steps = [...(editGates[gateIdx].verify || [])];
	const [moved] = steps.splice(fromStepIdx, 1);
	moved.phase = toPhase;
	// Find insertion point: toPosition-th slot within the target phase
	const targetPhaseSteps = steps.filter(s => (s.phase ?? 0) === toPhase);
	let insertAt: number;
	if (toPosition < targetPhaseSteps.length) {
		insertAt = steps.indexOf(targetPhaseSteps[toPosition]);
	} else {
		// After last step in phase, or at end if no steps
		if (targetPhaseSteps.length > 0) {
			insertAt = steps.indexOf(targetPhaseSteps[targetPhaseSteps.length - 1]) + 1;
		} else {
			insertAt = steps.length;
		}
	}
	steps.splice(insertAt, 0, moved);
	updateGateField(gateIdx, "verify", steps);
}

function handleVStepDragStart(e: DragEvent, gateIdx: number, stepIdx: number): void {
	vstepDragGateIdx = gateIdx;
	vstepDragStepIdx = stepIdx;
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/x-vstep", `${gateIdx}:${stepIdx}`);
	}
	renderApp();
}

function handleVStepDragOver(e: DragEvent, phase: number, position: number): void {
	e.preventDefault();
	e.stopPropagation();
	if (vstepDragGateIdx === null) return;
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	const newTarget = { phase, position };
	if (!vstepDropTarget || vstepDropTarget.phase !== newTarget.phase || vstepDropTarget.position !== newTarget.position) {
		vstepDropTarget = newTarget;
		renderApp();
	}
}

function handleVStepDrop(e: DragEvent): void {
	e.preventDefault();
	e.stopPropagation();
	if (vstepDragGateIdx !== null && vstepDragStepIdx !== null && vstepDropTarget !== null) {
		moveVerifyStep(vstepDragGateIdx, vstepDragStepIdx, vstepDropTarget.phase, vstepDropTarget.position);
	}
	vstepDragGateIdx = null;
	vstepDragStepIdx = null;
	vstepDropTarget = null;
	renderApp();
}

function handleVStepDragEnd(): void {
	vstepDragGateIdx = null;
	vstepDragStepIdx = null;
	vstepDropTarget = null;
	renderApp();
}

// Touch drag for verification steps
let vstepTouchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let vstepTouchDragging = false;
function cancelVStepTouchDrag(): void {
	if (vstepTouchLongPressTimer) { clearTimeout(vstepTouchLongPressTimer); vstepTouchLongPressTimer = null; }
	if (vstepTouchDragging || vstepDragGateIdx !== null) {
		vstepTouchDragging = false;
		vstepDragGateIdx = null;
		vstepDragStepIdx = null;
		vstepDropTarget = null;
		renderApp();
	}
}

function vstepTouchDropTarget(clientY: number, gateIdx: number): { phase: number; position: number } | null {
	const phaseGroups = document.querySelectorAll(`.wf-phase-group[data-gate-idx="${gateIdx}"]`);
	for (const group of phaseGroups) {
		const phase = parseInt(group.getAttribute("data-phase") || "0", 10);
		const cards = group.querySelectorAll(".wf-vstep-card");
		for (let i = 0; i < cards.length; i++) {
			const rect = cards[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return { phase, position: i };
		}
		// Past all cards in this group
		const groupRect = group.getBoundingClientRect();
		if (clientY < groupRect.bottom) return { phase, position: cards.length };
	}
	// Default: last phase, end
	const phases = getAllPhaseNumbers(gateIdx);
	const lastPhase = phases.length > 0 ? phases[phases.length - 1] : 0;
	return { phase: lastPhase, position: 999 };
}

function startVStepTouchDrag(gateIdx: number, stepIdx: number): void {
	vstepTouchDragging = true;
	vstepDragGateIdx = gateIdx;
	vstepDragStepIdx = stepIdx;
	renderApp();
}

function handleVStepGripTouchStart(e: TouchEvent, gateIdx: number, stepIdx: number): void {
	e.preventDefault();
	e.stopPropagation();
	startVStepTouchDrag(gateIdx, stepIdx);
}

function handleVStepHeaderTouchStart(e: TouchEvent, gateIdx: number, stepIdx: number): void {
	const touch = e.touches[0];
	const startY = touch.clientY;
	const startX = touch.clientX;
	vstepTouchLongPressTimer = setTimeout(() => {
		vstepTouchLongPressTimer = null;
		startVStepTouchDrag(gateIdx, stepIdx);
	}, 500);
	const moveCancel = (ev: TouchEvent) => {
		const t = ev.touches[0];
		if (Math.abs(t.clientY - startY) > 10 || Math.abs(t.clientX - startX) > 10) {
			if (vstepTouchLongPressTimer) { clearTimeout(vstepTouchLongPressTimer); vstepTouchLongPressTimer = null; }
			document.removeEventListener("touchmove", moveCancel);
		}
	};
	document.addEventListener("touchmove", moveCancel, { passive: true });
}

function handleVStepTouchMove(e: TouchEvent): void {
	if (!vstepTouchDragging || vstepDragGateIdx === null) return;
	e.preventDefault();
	const touch = e.touches[0];
	const target = vstepTouchDropTarget(touch.clientY, vstepDragGateIdx);
	if (target && (!vstepDropTarget || vstepDropTarget.phase !== target.phase || vstepDropTarget.position !== target.position)) {
		vstepDropTarget = target;
		renderApp();
	}
}

function handleVStepTouchEnd(): void {
	if (vstepTouchLongPressTimer) { clearTimeout(vstepTouchLongPressTimer); vstepTouchLongPressTimer = null; }
	if (!vstepTouchDragging || vstepDragGateIdx === null) return;
	if (vstepDragStepIdx !== null && vstepDropTarget !== null) {
		moveVerifyStep(vstepDragGateIdx, vstepDragStepIdx, vstepDropTarget.phase, vstepDropTarget.position);
	}
	vstepTouchDragging = false;
	vstepDragGateIdx = null;
	vstepDragStepIdx = null;
	vstepDropTarget = null;
	renderApp();
}

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	// Compact phases before saving
	const compacted = compactPhases(editGates);

	// Auto-compute dependsOn from gate order (each gate depends on the one above it)
	const gatesWithDeps = compacted.map((g, i) => ({
		...g,
		dependsOn: i > 0 && compacted[i - 1].id ? [compacted[i - 1].id] : [],
	}));

	if (isNew) {
		const result = await createWorkflow({
			id: editId,
			name: editName,
			description: editDescription,
			gates: gatesWithDeps,
		}, getConfigProjectId() || undefined);
		if (result) {
			workflows = await fetchWorkflowsScoped();
			showEdit(result);
			return;
		}
	} else if (selectedWorkflow) {
		const ok = await updateWorkflow(selectedWorkflow.id, {
			name: editName,
			description: editDescription,
			gates: gatesWithDeps,
		}, getConfigProjectId() || undefined);
		if (ok) {
			workflows = await fetchWorkflowsScoped();
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

	const ok = await deleteWorkflow(workflow.id, getConfigProjectId() || undefined);
	if (ok) {
		workflows = await fetchWorkflowsScoped();
		if (selectedWorkflow?.id === workflow.id) {
			showList();
		}
		renderApp();
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
	notifyControlledChange();
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
	notifyControlledChange();
	renderApp();
}

function updateGateField(index: number, field: string, value: any): void {
	editGates = editGates.map((g, i) => i === index ? { ...g, [field]: value } : g);
	notifyControlledChange();
	renderApp();
}

// Build the current draft and notify the controller (if any).
function notifyControlledChange(): void {
	if (!editorController) return;
	const draft: Workflow = {
		id: editId,
		name: editName,
		description: editDescription,
		gates: editGates.map((g) => ({
			...g,
			dependsOn: [...g.dependsOn],
			verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
			metadata: g.metadata ? { ...g.metadata } : undefined,
		})),
	} as Workflow;
	try { editorController.onChange(draft); } catch { /* ignore controller errors */ }
}

function toggleGateExpand(index: number): void {
	if (expandedGateIndices.has(index)) {
		expandedGateIndices.delete(index);
	} else {
		expandedGateIndices.add(index);
	}
	renderApp();
}

function toggleVStepExpand(gateIdx: number, stepIdx: number): void {
	const key = `${gateIdx}-${stepIdx}`;
	if (expandedVStepKeys.has(key)) {
		expandedVStepKeys.delete(key);
	} else {
		expandedVStepKeys.add(key);
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
	notifyControlledChange();

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
	const count = (gate.verify || []).length;
	if (count === 0) return "";
	return `${count} verification${count !== 1 ? "s" : ""}`;
}

// ============================================================================
// RENDER: VERIFY STEP EDITOR
// ============================================================================

function renderVerifyStepEditor(gate: WorkflowGate, gateIdx: number, step: VerifyStep, stepIdx: number): TemplateResult {
	const readOnly = isReadOnly();
	const typeIcon = step.type === "command" ? Terminal : step.type === "agent-qa" ? TestTube : MessageSquare;
	const isVStepExpanded = expandedVStepKeys.has(`${gateIdx}-${stepIdx}`);
	const isDragging = vstepDragGateIdx === gateIdx && vstepDragStepIdx === stepIdx;
	const vstepClasses = [
		"wf-vstep-card",
		isVStepExpanded ? "vstep-expanded" : "",
		isDragging ? "vstep-dragging" : "",
		readOnly ? "wf-vstep-readonly" : "",
	].filter(Boolean).join(" ");
	return html`
		<div class=${vstepClasses}
			draggable=${readOnly ? "false" : "true"}
			@dragstart=${readOnly ? undefined : (e: DragEvent) => { e.stopPropagation(); handleVStepDragStart(e, gateIdx, stepIdx); }}
			@dragend=${readOnly ? undefined : handleVStepDragEnd}>
			<div class="wf-vstep-collapsed-header"
				@click=${(e: Event) => { e.stopPropagation(); toggleVStepExpand(gateIdx, stepIdx); }}
				@touchstart=${readOnly ? undefined : (e: TouchEvent) => handleVStepHeaderTouchStart(e, gateIdx, stepIdx)}
				@touchmove=${readOnly ? undefined : handleVStepTouchMove}
				@touchend=${readOnly ? undefined : handleVStepTouchEnd}
				@touchcancel=${readOnly ? undefined : cancelVStepTouchDrag}>
				${readOnly ? nothing : html`<span class="wf-vstep-grip"
					@touchstart=${(e: TouchEvent) => handleVStepGripTouchStart(e, gateIdx, stepIdx)}>${icon(GripVertical, "sm")}</span>`}
				<span class="wf-vstep-chevron">\u25B8</span>
				<span class="wf-verify-type-icon">${icon(typeIcon, "sm")}</span>
				<span class="wf-vstep-name-label">${step.name || "(unnamed)"}</span>
				<span class="wf-vstep-sep">\u00B7</span>
				<span class="wf-vstep-type-label">${step.type || "command"}</span>
				${step.optional ? html`<span class="wf-vstep-optional-badge">optional</span>` : nothing}
				<span class="wf-vstep-spacer"></span>
				${readOnly ? nothing : html`<button class="wf-criteria-remove" title="Remove verification step" @click=${(e: Event) => {
					e.stopPropagation();
					const steps = (gate.verify || []).filter((_: any, i: number) => i !== stepIdx);
					updateGateField(gateIdx, "verify", steps);
				}}>${icon(Trash2, "sm")}</button>`}
			</div>
			<div class="wf-vstep-body">
				<div class="wf-vstep-fields">
					<div class="wf-identity-row">
						<label class="wf-field-label">Name</label>
						<input class="wf-input" style="flex:1;min-width:0;" .value=${step.name || ""} placeholder="Step name"
							?disabled=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								const steps = [...(gate.verify || [])];
								steps[stepIdx] = { ...steps[stepIdx], name: (e.target as HTMLInputElement).value };
								updateGateField(gateIdx, "verify", steps);
							}} />
						<label class="wf-field-label" style="margin-left:8px;">Type</label>
						<select class="wf-select" .value=${step.type || "command"}
							?disabled=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@change=${(e: Event) => {
								const steps = [...(gate.verify || [])];
								steps[stepIdx] = { ...steps[stepIdx], type: (e.target as HTMLSelectElement).value as "command" | "llm-review" | "agent-qa" };
								updateGateField(gateIdx, "verify", steps);
							}}>
							<option value="command" ?selected=${step.type === "command"}>command</option>
							<option value="llm-review" ?selected=${step.type === "llm-review"}>llm-review</option>
							<option value="agent-qa" ?selected=${step.type === "agent-qa"}>agent-qa</option>
						</select>
						${step.type === "command" ? html`
							<label class="wf-field-label" style="margin-left:8px;">Expect</label>
							<select class="wf-select" .value=${step.expect || "success"}
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => {
									const steps = [...(gate.verify || [])];
									steps[stepIdx] = { ...steps[stepIdx], expect: (e.target as HTMLSelectElement).value as "success" | "failure" };
									updateGateField(gateIdx, "verify", steps);
								}}>
								<option value="success" ?selected=${step.expect !== "failure"}>success</option>
								<option value="failure" ?selected=${step.expect === "failure"}>failure</option>
							</select>
						` : nothing}
					</div>
					${step.type === "command" ? html`
						<input class="wf-input" .value=${step.run || ""} placeholder="Command to run..."
							?disabled=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								const steps = [...(gate.verify || [])];
								steps[stepIdx] = { ...steps[stepIdx], run: (e.target as HTMLInputElement).value };
								updateGateField(gateIdx, "verify", steps);
							}} />
						${readOnly ? nothing : html`<div class="wf-field-hint">Variables: {{branch}}, {{master}}, {{cwd}}, {{project.key}}, {{agent.key}}, {{gate_id.meta.key}}</div>`}
					` : html`
						<textarea class="wf-textarea" .value=${step.prompt || ""} placeholder="${step.type === "agent-qa" ? "QA test prompt..." : "Review prompt..."}"
							?readonly=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								const steps = [...(gate.verify || [])];
								steps[stepIdx] = { ...steps[stepIdx], prompt: (e.target as HTMLTextAreaElement).value };
								updateGateField(gateIdx, "verify", steps);
							}}></textarea>
					`}
					${readOnly && !step.optional && !step.label ? nothing : html`<div class="wf-vstep-optional-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" .checked=${step.optional === true}
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => {
									const steps = [...(gate.verify || [])];
									steps[stepIdx] = { ...steps[stepIdx], optional: (e.target as HTMLInputElement).checked || undefined };
									if (!steps[stepIdx].optional) { delete steps[stepIdx].label; delete steps[stepIdx].optional; }
									updateGateField(gateIdx, "verify", steps);
								}} />
							<span>Optional</span>
						</label>
						${step.optional ? html`
							<input class="wf-input" style="flex:1;" .value=${step.label || ""} placeholder="UI label (e.g. Enable QA Testing)"
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => {
									const steps = [...(gate.verify || [])];
									steps[stepIdx] = { ...steps[stepIdx], label: (e.target as HTMLInputElement).value || undefined };
									updateGateField(gateIdx, "verify", steps);
								}} />
						` : nothing}
					</div>`}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// OPEN PROJECT ASSISTANT (replaces the legacy workflow assistant)
//
// Workflows are designed and edited via the project assistant now — it owns
// the full project.yaml including the inline workflows: block. Opening it
// from the workflows page seeds an edit session against the current project.
// ============================================================================

export async function openProjectAssistantForWorkflows(): Promise<void> {
	if (state.creatingSession) return;
	const projectId = getConfigProjectId();
	const project = (state.projects || []).find((p: any) => p.id === projectId) as any;
	if (!project?.rootPath) {
		console.warn("openProjectAssistantForWorkflows: no active project with rootPath");
		return;
	}
	const { createProjectAssistantSession } = await import("./dialogs.js");
	await createProjectAssistantSession(project.rootPath, false, { projectId, existingProjectName: project.name || "" });
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
						onClick: () => selectedWorkflow ? handleDelete(selectedWorkflow) : showList(),
						className: "wf-nav-delete",
						children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} Delete</span>`,
					})}
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
					variant: "default",
					size: "sm",
					onClick: openProjectAssistantForWorkflows,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Sparkles, "sm")} Open Project Assistant</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

async function handleScopeChange(scope: string): Promise<void> {
	setConfigScope(scope);
	loading = true;
	renderApp();
	workflows = await fetchWorkflowsScoped();
	loading = false;
	renderApp();
}

function renderWorkflowRow(wf: Workflow): TemplateResult {
	return renderWorkflowListRow({
		workflow: wf,
		selected: false,
		onSelect: () => showEdit(wf),
		actions: html`
			<button class="wf-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(wf); }} title="Edit">
				${icon(Pencil, "sm")}
			</button>
			<button class="wf-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDelete(wf); }} title="Delete">
				${icon(Trash2, "sm")}
			</button>
		`,
	});
}

// ============================================================================
// EXPORTED RENDERERS — reusable from embeds (e.g. the goal-proposal modal).
// These are stateless: every piece of state and every callback is supplied
// by the caller. The page itself uses them via thin wrappers above so the
// markup and class names stay identical wherever a workflow is shown.
// ============================================================================

function renderWorkflowListRow(opts: {
	workflow: Workflow;
	selected: boolean;
	dirty?: boolean;
	onSelect: () => void;
	actions?: TemplateResult | string;
}): TemplateResult {
	const { workflow: wf, selected, dirty, onSelect, actions } = opts;
	return html`
		<div class="wf-row ${selected ? "wf-row-selected" : ""}" tabindex="0" role="button"
			aria-selected=${selected ? "true" : "false"}
			data-workflow-id=${wf.id}
			@click=${onSelect}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
			<div class="wf-row-info">
				<span class="wf-row-name">${wf.name}${dirty ? html`<span class="wf-row-dirty" title="Customized for this goal"> · customized</span>` : nothing}</span>
				<span class="wf-row-desc">${wf.description}</span>
			</div>
			<div class="wf-row-badges">
				<span class="wf-badge">${wf.gates.length} gate${wf.gates.length !== 1 ? "s" : ""}</span>
			</div>
			${actions ? html`<div class="wf-row-actions">${actions}</div>` : nothing}
		</div>
	`;
}

/**
 * Stateless workflow list renderer. Reused by the Workflows page list view
 * and by the goal-proposal modal's Workflow tab. Pass `selectedId` to
 * highlight a row; pass `dirtyIds` to badge rows that have been customized
 * for the current scope (e.g. a goal draft).
 */
export function renderWorkflowList(opts: {
	workflows: Workflow[];
	selectedId?: string | null;
	dirtyIds?: ReadonlySet<string>;
	onSelect: (wf: Workflow) => void;
	scope?: EditorScope;
}): TemplateResult {
	const { workflows: list, selectedId, dirtyIds, onSelect } = opts;
	return html`
		<div class="wf-list" data-testid="workflow-list">
			${list.map((wf) => renderWorkflowListRow({
				workflow: wf,
				selected: selectedId === wf.id,
				dirty: dirtyIds?.has(wf.id) ?? false,
				onSelect: () => onSelect(wf),
			}))}
		</div>
	`;
}

/**
 * Stateless, read-only workflow inspector. Implemented by seeding the same
 * module-level edit state used by the editor and delegating to the shared
 * `renderEditView()` with a `readOnly: true` controller. This guarantees
 * one single source of truth for gate / verification step markup — adding
 * a field to the editor automatically surfaces it in the inspector with no
 * forked copy to keep in sync.
 */
export function renderWorkflowInspector(opts: {
	workflow: Workflow | null;
	scope?: EditorScope;
}): TemplateResult {
	const wf = opts.workflow;
	if (!wf) {
		return html`<div class="wf-empty" data-testid="workflow-inspector-empty">
			<p class="wf-empty-title">No workflow selected</p>
			<p class="wf-empty-desc">Pick a workflow from the list to see its gates and verification steps.</p>
		</div>`;
	}
	const scope: EditorScope = opts.scope ?? "goal-draft";
	const inspectorKey = `__inspector__:${wf.id}`;
	const needsReseed = !editorController
		|| editorController.workflowKey !== inspectorKey
		|| editorController.readOnly !== true;
	if (needsReseed) {
		editorController = { scope, workflowKey: inspectorKey, onChange: () => {}, readOnly: true };
		selectedWorkflow = null;
		isNew = false;
		editId = wf.id;
		editName = wf.name;
		editDescription = wf.description;
		editGates = (wf.gates || []).map((g) => ({
			...g,
			dependsOn: [...(g.dependsOn || [])],
			verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
			metadata: g.metadata ? { ...g.metadata } : undefined,
		}));
		// Expand everything by default so the read-only inspector shows the
		// full workflow at a glance. Users can still click to collapse.
		expandedGateIndices = new Set<number>(editGates.map((_, i) => i));
		expandedVStepKeys = new Set<string>();
		editGates.forEach((g, gi) => {
			(g.verify || []).forEach((_, si) => expandedVStepKeys.add(`${gi}-${si}`));
		});
	}
	return renderEditView();
}

/**
 * Stateless workflow editor. Seeds module state from `workflow` whenever the
 * workflow id changes, then renders the same edit view used by the page —
 * minus save/delete chrome when `scope === "goal-draft"`. Every mutation is
 * forwarded to `onChange(updatedWorkflow)` so the caller owns persistence.
 */
export function renderWorkflowEditor(opts: {
	workflow: Workflow;
	onChange: (wf: Workflow) => void;
	scope?: EditorScope;
}): TemplateResult {
	const scope: EditorScope = opts.scope ?? "goal-draft";
	const key = opts.workflow.id || "__draft__";
	const needsReseed = !editorController
		|| editorController.workflowKey !== key
		|| editorController.readOnly === true;
	if (needsReseed) {
		editorController = { scope, workflowKey: key, onChange: opts.onChange };
		selectedWorkflow = null;
		isNew = !opts.workflow.id;
		editId = opts.workflow.id || "";
		editName = opts.workflow.name || "";
		editDescription = opts.workflow.description || "";
		editGates = (opts.workflow.gates || []).map((g) => ({
			...g,
			dependsOn: [...(g.dependsOn || [])],
			verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
			metadata: g.metadata ? { ...g.metadata } : undefined,
		}));
		expandedGateIndices = new Set();
		expandedVStepKeys = new Set();
	} else {
		editorController = { scope, workflowKey: key, onChange: opts.onChange };
	}
	return renderEditView();
}

/** Clear the controlled-editor binding. Embeds should call this when the
 * embed unmounts so the next page-level edit starts cleanly. */
export function clearWorkflowEditorController(): void {
	editorController = null;
}

function renderListView(): TemplateResult {
	// No projects — workflows live in projects, so invite the user to add one.
	if ((state.projects || []).length === 0) {
		return html`
			<div class="wf-empty">
				<p class="wf-empty-title">No projects yet</p>
				<p class="wf-empty-desc">Workflows live inside projects. Add a project from the sidebar to start defining workflows.</p>
			</div>
		`;
	}
	if (loading) {
		return html`
			<div class="wf-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading workflows…</span>
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
					onClick: openProjectAssistantForWorkflows,
					children: html`<span class="inline-flex items-center gap-1.5" data-testid="open-project-assistant-from-workflows-empty">${icon(Sparkles, "sm")} Open Project Assistant</span>`,
				})}
				<p class="text-xs text-muted-foreground mt-2">Or use the manual editor: <button class="underline" @click=${showNewEdit}>create one by hand</button>.</p>
			</div>
		`;
	}

	return html`
		<div class="wf-list-header flex items-start gap-4">
			<p class="text-sm text-muted-foreground flex-1 m-0">Workflows define the stages (gates) a goal goes through \u2014 like design \u2192 implement \u2192 test \u2192 review. They ensure quality by enforcing order and verification.</p>
			<div class="shrink-0">${Button({
				variant: "default",
				size: "sm",
				onClick: openProjectAssistantForWorkflows,
				children: html`<span class="inline-flex items-center gap-1.5 font-semibold" data-testid="open-project-assistant-from-workflows">${icon(Sparkles, "sm")} Open Project Assistant</span>`,
			})}</div>
		</div>
		<div class="wf-list">
			${workflows.map((wf) => renderWorkflowRow(wf))}
		</div>
	`;
}

// ============================================================================
// RENDER: PHASE GROUPS
// ============================================================================

function renderPhaseGroups(gate: WorkflowGate, gateIdx: number): TemplateResult {
	const readOnly = isReadOnly();
	const steps = gate.verify || [];
	const grouped = groupStepsByPhase(steps);
	const allPhases = getAllPhaseNumbers(gateIdx);

	// If no phases at all (no steps, no empty phases), just show phase 0
	if (allPhases.length === 0 && steps.length === 0) {
		if (readOnly) {
			// Inspector: a workflow with zero verification steps just renders
			// the empty-state hint without drag targets.
			return html`<div class="wf-phase-group" data-phase="0"><div class="wf-phase-body wf-phase-empty-hint">No verification steps</div></div>`;
		}
		return html`
			<div class="wf-phase-group" data-gate-idx="${gateIdx}" data-phase="0"
				@dragover=${(e: DragEvent) => handleVStepDragOver(e, 0, 0)}
				@drop=${handleVStepDrop}>
				<div class="wf-phase-header"><span>Phase 0</span></div>
				<div class="wf-phase-body wf-phase-empty-hint">No steps</div>
			</div>
		`;
	}

	return html`${allPhases.map(phase => {
		const phaseSteps = grouped.get(phase) || [];
		const isEmpty = phaseSteps.length === 0;
		const isEmptyTracked = emptyPhases.get(gateIdx)?.has(phase) ?? false;
		return html`
			<div class="wf-phase-group" data-gate-idx="${gateIdx}" data-phase="${phase}"
				@dragover=${readOnly ? undefined : (e: DragEvent) => {
					// Allow drop on empty phase body
					if (isEmpty) handleVStepDragOver(e, phase, 0);
				}}
				@drop=${readOnly ? undefined : handleVStepDrop}>
				<div class="wf-phase-header">
					<span>Phase ${phase}</span>
					${!readOnly && isEmpty && isEmptyTracked ? html`
						<button class="wf-phase-delete" title="Remove empty phase" @click=${(e: Event) => {
							e.stopPropagation();
							removeEmptyPhase(gateIdx, phase);
						}}>${icon(Trash2, "sm")}</button>
					` : nothing}
				</div>
				<div class="wf-phase-body">
					${phaseSteps.length === 0 && !readOnly ? html`<div class="wf-phase-empty-hint">No steps — drag here or add one</div>` : nothing}
					${phaseSteps.map((entry, posInPhase) => html`
						${!readOnly && vstepDropTarget && vstepDropTarget.phase === phase && vstepDropTarget.position === posInPhase && vstepDragGateIdx === gateIdx
							? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
						<div
							@dragover=${readOnly ? undefined : (e: DragEvent) => {
								const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
								const midY = rect.top + rect.height / 2;
								const pos = e.clientY < midY ? posInPhase : posInPhase + 1;
								handleVStepDragOver(e, phase, pos);
							}}>
							${renderVerifyStepEditor(gate, gateIdx, entry.step, entry.originalIndex)}
						</div>
					`)}
					${!readOnly && vstepDropTarget && vstepDropTarget.phase === phase && vstepDropTarget.position >= phaseSteps.length && vstepDragGateIdx === gateIdx
						? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
				</div>
			</div>
		`;
	})}`;
}

// ============================================================================
// RENDER: GATE EDITOR (collapsible card)
// ============================================================================

function renderGateEditor(gate: WorkflowGate, idx: number): TemplateResult {
	const readOnly = isReadOnly();
	const isExpanded = expandedGateIndices.has(idx);
	const isDragging = dragIndex === idx;
	const verifySummary = getVerifySummary(gate);
	const verifyCount = (gate.verify || []).length;
	const gateClasses = [
		"wf-gate-card",
		isExpanded ? "expanded" : "",
		isDragging ? "dragging" : "",
		readOnly ? "wf-gate-readonly" : "",
	].filter(Boolean).join(" ");

	return html`
		${dropTargetIndex === idx && dragIndex !== null && dragIndex !== idx ? html`<div class="wf-drop-indicator"></div>` : nothing}
		<div class=${gateClasses} data-gate-id=${gate.id}>
			<div class="wf-gate-header"
				draggable=${readOnly ? "false" : "true"}
				@dragstart=${readOnly ? undefined : (e: DragEvent) => handleDragStart(e, idx)}
				@dragover=${readOnly ? undefined : (e: DragEvent) => handleDragOver(e, idx)}
				@drop=${readOnly ? undefined : handleDrop}
				@dragend=${readOnly ? undefined : handleDragEnd}
				@touchstart=${readOnly ? undefined : (e: TouchEvent) => handleHeaderTouchStart(e, idx)}
				@touchmove=${readOnly ? undefined : handleTouchMove}
				@touchend=${readOnly ? undefined : handleTouchEnd}
				@touchcancel=${readOnly ? undefined : cancelTouchDrag}
				@click=${() => toggleGateExpand(idx)}>
				${readOnly ? nothing : html`<span class="wf-gate-grip"
					@touchstart=${(e: TouchEvent) => handleGripTouchStart(e, idx)}>${icon(GripVertical, "sm")}</span>`}
				<span class="wf-gate-idx">${idx + 1}</span>
				<span class="wf-gate-chevron">\u25B8</span>
				<span class="wf-gate-name">${gate.name || "(unnamed)"}</span>
				${readOnly && gate.content ? html`<span class="wf-gate-pill">content</span>` : nothing}
				${readOnly && gate.injectDownstream ? html`<span class="wf-gate-pill">inject downstream</span>` : nothing}
				${verifySummary ? html`<span class="wf-gate-pill">${verifySummary}</span>` : nothing}
				${readOnly ? nothing : html`<button class="wf-gate-delete" @click=${(e: Event) => { e.stopPropagation(); removeGate(idx); }} title="Remove gate">${icon(Trash2, "sm")}</button>`}
			</div>

			<div class="wf-gate-body">
				<div class="wf-gate-body-inner">
					<div class="wf-identity-row">
						<label class="wf-field-label">ID</label>
						<input class="wf-input" style="width:140px;" .value=${gate.id} placeholder="e.g. issue-analysis"
							?disabled=${readOnly}
							@input=${(e: Event) => updateGateField(idx, "id", (e.target as HTMLInputElement).value)} />
						<label class="wf-field-label" style="margin-left:8px;">Name</label>
						<input class="wf-input" style="flex:1;min-width:0;" .value=${gate.name} placeholder="Display name"
							?disabled=${readOnly}
							@input=${(e: Event) => updateGateField(idx, "name", (e.target as HTMLInputElement).value)} />
					</div>

					${readOnly && gate.dependsOn && gate.dependsOn.length > 0 ? html`
						<div class="wf-identity-row">
							<label class="wf-field-label">Depends on</label>
							<span class="wf-inspector-value">${gate.dependsOn.join(", ")}</span>
						</div>
					` : nothing}

					${readOnly ? nothing : html`<div class="wf-toggles-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" .checked=${gate.content === true}
								@change=${(e: Event) => updateGateField(idx, "content", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Content</span>
							<span class="wf-info-icon" title="Content gates store a markdown document">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" .checked=${gate.injectDownstream === true}
								@change=${(e: Event) => updateGateField(idx, "injectDownstream", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Inject downstream</span>
							<span class="wf-info-icon" title="Agents working towards subsequent gates have the content attached to this gate injected into their context">i</span>
						</label>
					</div>`}

					<div class="wf-field">
						<span class="wf-verify-label">Verification Steps (${verifyCount})</span>
						<div class="wf-verification-steps">
							${renderPhaseGroups(gate, idx)}
							${readOnly ? nothing : html`<div class="wf-phase-actions">
								<button class="wf-criteria-add-btn" title="Add verification step" @click=${(e: Event) => {
									e.stopPropagation();
									const steps = [...(gate.verify || []), { name: "", type: "command" as const, run: "" }];
									updateGateField(idx, "verify", steps);
								}}>Add Step</button>
								<button class="wf-criteria-add-btn wf-add-phase-btn" title="Add a new phase" @click=${(e: Event) => {
									e.stopPropagation();
									addPhase(idx);
								}}>Add Phase</button>
							</div>`}
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

function autoGrowTextarea(el: HTMLTextAreaElement): void {
	el.style.height = '0';
	el.style.height = Math.max(32, el.scrollHeight) + 'px';
}

function renderEditView(): TemplateResult {
	const controlled = editorController !== null;
	const readOnly = isReadOnly();
	const containerClasses = readOnly
		? "wf-edit-container wf-container-embedded wf-inspector"
		: "wf-edit-container";
	const testId = readOnly ? "workflow-inspector" : "workflow-editor";
	return html`
		<div class=${containerClasses}
			data-testid=${testId}
			data-scope=${editorController?.scope ?? "project"}
			data-workflow-id=${editId}>
			<div class="wf-edit-identity">
				${controlled ? nothing : html`
					<div class="flex items-center justify-between mb-1">
						<span>${selectedWorkflow ? renderOriginBadge((selectedWorkflow as any).origin, (selectedWorkflow as any).overrides) : ""}</span>
						${renderCustomizeRevertButtons()}
					</div>
				`}
				<div class="wf-identity-row">
					<label class="wf-field-label">ID</label>
					${isNew && !readOnly ? html`
						<input class="wf-input" style="width:140px;" .value=${editId} placeholder="e.g. bug-fix"
							@input=${(e: Event) => { editId = (e.target as HTMLInputElement).value; notifyControlledChange(); renderApp(); }} />
					` : html`
						<input class="wf-input" style="width:140px;opacity:0.6;cursor:not-allowed;" .value=${editId} disabled />
					`}
					<label class="wf-field-label" style="margin-left:8px;">Name</label>
					<input class="wf-input" style="flex:1;min-width:0;" .value=${editName} placeholder="Workflow name"
						?disabled=${readOnly}
						@input=${(e: Event) => { editName = (e.target as HTMLInputElement).value; notifyControlledChange(); renderApp(); }} />
				</div>
				<div class="wf-identity-row">
					<label class="wf-field-label" style="flex-shrink:0;">Description</label>
					<textarea class="wf-textarea wf-desc-auto" rows="1" .value=${editDescription} placeholder="What this workflow does"
						?readonly=${readOnly}
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; notifyControlledChange(); autoGrowTextarea(e.target as HTMLTextAreaElement); }}></textarea>
				</div>
			</div>

			<div class="wf-artifacts-list">
				${editGates.map((gate, idx) => renderGateEditor(gate, idx))}
				${editGates.length === 0 && readOnly ? html`<div class="wf-empty"><p class="wf-empty-desc">This workflow has no gates.</p></div>` : nothing}
				${readOnly ? nothing : Button({
					variant: "secondary" as any,
					size: "sm",
					className: "wf-add-gate-btn",
					onClick: addGate,
					children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add Gate</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

function renderCustomizeRevertButtons(): TemplateResult | string {
	// Workflows are project-scoped only — there is no builtin or server
	// layer to inherit from, so the only meaningful action is reverting a
	// project-level override (i.e. removing the workflow from project.yaml).
	if (!selectedWorkflow || isNew) return "";
	const origin = (selectedWorkflow as any).origin as ConfigOrigin | undefined;
	if (origin !== "project") return "";
	const projectId = getConfigProjectId();
	return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
		if (await revertOverride("workflows", selectedWorkflow!.id, "project", projectId)) {
			workflows = await fetchWorkflowsScoped();
			const updated = workflows.find(w => w.id === selectedWorkflow!.id);
			if (updated) showEdit(updated); else showList();
		}
	}}>Revert to Inherited</button>`;
}

export function renderWorkflowPage(opts?: { embedded?: boolean }): TemplateResult {
	const embedded = !!opts?.embedded;
	return html`
		<div class="wf-container ${embedded ? "wf-container-embedded" : ""}">
			${embedded ? "" : renderNavBar()}
			${!embedded && currentView === "list" ? renderConfigScopeRow(getConfigScope(), handleScopeChange, true) : ""}
			<div class="wf-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
