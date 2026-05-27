// CSS for this page (and the project-proposal preview pane that reuses
// .wf-* classes) is eagerly imported from main.ts so it is available even
// when this lazy page module has not been loaded yet.
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, nothing, type TemplateResult } from "lit";
import { AlertCircle, ArrowLeft, GripVertical, MessageSquare, Pencil, Plus, Sparkles, Terminal, TestTube, Trash2, UserCheck } from "lucide";
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

// Project components cache (for the `component` step-field dropdown).
let projectComponentNames: string[] = [];

// Draft metadata rows per gate (ordered list of [key, value] pairs). Mirrors
// `gate.metadata` for editing but keeps blank rows visible. Synced into
// `gate.metadata` on every keystroke (stripping blank keys) so save is
// consistent with the rendered state.
let metadataDrafts: Map<number, Array<[string, string]>> = new Map();

/** Initialise draft rows from existing gate.metadata records. */
function seedMetadataDrafts(gates: WorkflowGate[]): void {
	metadataDrafts = new Map();
	gates.forEach((g, i) => {
		if (g.metadata) {
			metadataDrafts.set(i, Object.entries(g.metadata).map(([k, v]) => [k, v]));
		}
	});
}

// Top-level save-attempted state — used to surface inline validation errors.
let saveAttempted = false;
let saveBlockedReason: string | null = null;

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate a single VerifyStep. Returns a per-field error map (or empty object
 * when valid). Empty values are treated as missing.
 */
export function validateStep(step: VerifyStep): Record<string, string> {
	const errs: Record<string, string> = {};
	if (!step.name || !step.name.trim()) errs.name = "Name is required.";
	if (step.type === "human-signoff") {
		if (!step.label || !step.label.trim()) errs.label = "Card title is required.";
		if (!step.prompt || !step.prompt.trim()) errs.prompt = "Prompt is required.";
	} else if (step.type === "llm-review" || step.type === "agent-qa") {
		if (!step.prompt || !step.prompt.trim()) errs.prompt = "Prompt is required.";
	} else if (step.type === "command") {
		const hasRun = !!(step.run && step.run.trim());
		const hasCmd = !!(step.command && step.command.trim());
		if (!hasRun && !hasCmd) errs.run = "Either a free-form `run` or a named `command` is required.";
		if (hasRun && hasCmd) errs.command = "Specify exactly one of `run` or `command`, not both.";
		if (hasCmd && !(step.component && step.component.trim())) errs.component = "Component is required for named commands.";
	}
	return errs;
}

/** Collect every validation error across all steps in editGates. */
function collectValidationErrors(gates: WorkflowGate[]): { gateIdx: number; stepIdx: number; errors: Record<string, string> }[] {
	const out: { gateIdx: number; stepIdx: number; errors: Record<string, string> }[] = [];
	gates.forEach((g, gi) => {
		(g.verify || []).forEach((s, si) => {
			const e = validateStep(s);
			if (Object.keys(e).length > 0) out.push({ gateIdx: gi, stepIdx: si, errors: e });
		});
	});
	return out;
}

async function loadProjectComponentsForEditor(): Promise<void> {
	projectComponentNames = [];
	const projectId = getConfigProjectId();
	if (!projectId) return;
	try {
		const res = await gatewayFetch(`/api/projects/${encodeURIComponent(projectId)}/structured`);
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		const comps = data && Array.isArray(data.components) ? data.components : [];
		projectComponentNames = comps
			.map((c: any) => (c && typeof c.name === "string") ? c.name : "")
			.filter((n: string) => n.length > 0);
	} catch {
		/* swallow — select degrades to a free-text option list */
	} finally {
		renderApp();
	}
}

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
	currentView = "edit";
	selectedWorkflow = workflow;
	isNew = false;
	editId = workflow.id;
	editName = workflow.name;
	editDescription = workflow.description;
	editGates = workflow.gates.map((g) => ({ ...g, dependsOn: [...g.dependsOn], verify: g.verify ? g.verify.map(v => ({ ...v })) : undefined, metadata: g.metadata ? { ...g.metadata } : undefined }));
	saving = false;
	saveAttempted = false;
	saveBlockedReason = null;
	expandedGateIndices = new Set();
	expandedVStepKeys = new Set();
	seedMetadataDrafts(editGates);
	void loadProjectComponentsForEditor();
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
	saveAttempted = false;
	saveBlockedReason = null;
	expandedGateIndices = new Set();
	expandedVStepKeys = new Set();
	metadataDrafts = new Map();
	void loadProjectComponentsForEditor();
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
	saveAttempted = true;
	saveBlockedReason = null;

	// Run validation before persisting. Block save on any error and surface
	// inline messages in the editor + a top-level banner.
	const issues = collectValidationErrors(editGates);
	if (issues.length > 0) {
		// Expand any gates that contain an invalid step so the user can see the
		// inline error without hunting for it.
		for (const { gateIdx, stepIdx } of issues) {
			expandedGateIndices.add(gateIdx);
			expandedVStepKeys.add(`${gateIdx}-${stepIdx}`);
		}
		saveBlockedReason = `${issues.length} verification step${issues.length === 1 ? "" : "s"} ha${issues.length === 1 ? "s" : "ve"} validation errors. Fix them and try again.`;
		saving = false;
		renderApp();
		return;
	}

	saving = true;
	renderApp();

	// Compact phases before saving
	const compacted = compactPhases(editGates);

	// Preserve the explicit DAG exactly as edited. `dependsOn: []` is a valid
	// YAML shape for root/parallel gates; do not silently rewrite it to a linear
	// previous-gate dependency on save.
	const gatesWithDeps = compacted.map(g => ({ ...g, dependsOn: g.dependsOn || [] }));

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
	// Remap metadata drafts so they stay aligned with gate indices.
	const nextDrafts: Map<number, Array<[string, string]>> = new Map();
	for (const [i, rows] of metadataDrafts) {
		if (i < index) nextDrafts.set(i, rows);
		else if (i > index) nextDrafts.set(i - 1, rows);
	}
	metadataDrafts = nextDrafts;
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

	const nextDrafts: Map<number, Array<[string, string]>> = new Map();
	for (const [i, rows] of metadataDrafts) nextDrafts.set(remap(i), rows);
	metadataDrafts = nextDrafts;

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

/** Step-type icon lookup. */
function stepTypeIcon(type: VerifyStep["type"] | undefined): typeof Terminal {
	switch (type) {
		case "command": return Terminal;
		case "agent-qa": return TestTube;
		case "human-signoff": return UserCheck;
		case "llm-review": return MessageSquare;
		default: return Terminal;
	}
}

/**
 * Mutate a step's shape when the user picks a new `type`. Strips fields that
 * don't apply to the new type and initialises any required defaults so the
 * UI for the new type is immediately usable.
 */
function mutateStepForTypeChange(prev: VerifyStep, newType: VerifyStep["type"]): VerifyStep {
	const next: VerifyStep = { ...prev, type: newType };

	// Fields that are not meaningful for the new type should not survive as
	// hidden stale YAML. Keep only fields visible/valid for the chosen type.
	if (newType !== "command") {
		delete next.run;
		delete next.expect;
		delete next.command;
	} else {
		delete next.prompt;
		delete next.label;
		delete next.role;
		if (next.run === undefined && (next.command === undefined || next.command === "")) next.run = "";
	}

	if (newType !== "agent-qa" && newType !== "command") delete next.component;
	if (newType === "human-signoff") delete next.timeout;
	if (newType !== "human-signoff") delete next.label;
	if (next.optional !== true) delete next.optionalLabel;

	if (newType === "human-signoff") {
		if (next.label === undefined) next.label = "";
		if (next.prompt === undefined) next.prompt = "";
	} else if (newType !== "command") {
		if (next.prompt === undefined) next.prompt = "";
	}
	return next;
}

function renderVerifyStepEditor(gate: WorkflowGate, gateIdx: number, step: VerifyStep, stepIdx: number): TemplateResult {
	const typeIcon = stepTypeIcon(step.type);
	const isVStepExpanded = expandedVStepKeys.has(`${gateIdx}-${stepIdx}`);
	const isDragging = vstepDragGateIdx === gateIdx && vstepDragStepIdx === stepIdx;
	const errs = saveAttempted ? validateStep(step) : {};

	const currentSteps = (): VerifyStep[] => [...(((editGates[gateIdx] || gate).verify) || [])];
	const updateStep = (patch: Partial<VerifyStep>, rerender = false) => {
		// Read from the latest editGates state, not the render-time `gate` closure.
		// Most text inputs do not need a full app render on every keystroke; avoiding
		// that rerender keeps the focused DOM node stable and prevents rapid adjacent
		// edits from racing a stale render that clobbers sibling fields. Structural
		// edits (type switches, optional toggles, command-mode toggles) still call
		// updateGateField below because their visible controls change.
		const nextGates = [...editGates];
		const nextGate = { ...(nextGates[gateIdx] || gate) };
		const steps = [...(nextGate.verify || [])];
		steps[stepIdx] = { ...steps[stepIdx], ...patch };
		nextGate.verify = steps;
		nextGates[gateIdx] = nextGate;
		editGates = nextGates;
		if (rerender || saveAttempted) renderApp();
	};

	const stepType = step.type || "command";
	const showTimeoutField = stepType !== "human-signoff";
	const showRoleField = stepType === "llm-review" || stepType === "agent-qa" || stepType === "human-signoff";
	const showComponentField = stepType === "command" || stepType === "agent-qa";
	const componentOptions = projectComponentNames;

	const handleTypeChange = (e: Event) => {
		const steps = currentSteps();
		const newType = (e.target as HTMLSelectElement).value as VerifyStep["type"];
		steps[stepIdx] = mutateStepForTypeChange(steps[stepIdx], newType);
		updateGateField(gateIdx, "verify", steps);
	};
	const setCommandMode = (mode: "run" | "command") => {
		const steps = currentSteps();
		const patch: Partial<VerifyStep> = {};
		if (mode === "run") {
			patch.command = undefined;
			if (steps[stepIdx].run === undefined) patch.run = "";
			steps[stepIdx] = { ...steps[stepIdx], ...patch };
			delete steps[stepIdx].command;
		} else {
			patch.run = undefined;
			if (steps[stepIdx].command === undefined) patch.command = "";
			steps[stepIdx] = { ...steps[stepIdx], ...patch };
			delete steps[stepIdx].run;
		}
		updateGateField(gateIdx, "verify", steps);
	};

	// `command` step ships two mutually-exclusive ways to specify the command:
	//   - free-form `run` string (with template variables)
	//   - structural ref to a named `command` on the chosen `component`
	const useNamedCommand = stepType === "command" && step.command !== undefined;

	return html`
		<div class="wf-vstep-card ${isVStepExpanded ? "vstep-expanded" : ""} ${isDragging ? "vstep-dragging" : ""}"
			data-testid="wf-vstep-card"
			data-step-type="${stepType}"
			draggable="true"
			@dragstart=${(e: DragEvent) => { e.stopPropagation(); handleVStepDragStart(e, gateIdx, stepIdx); }}
			@dragend=${handleVStepDragEnd}>
			<div class="wf-vstep-collapsed-header"
				@click=${(e: Event) => { e.stopPropagation(); toggleVStepExpand(gateIdx, stepIdx); }}
				@touchstart=${(e: TouchEvent) => handleVStepHeaderTouchStart(e, gateIdx, stepIdx)}
				@touchmove=${handleVStepTouchMove}
				@touchend=${handleVStepTouchEnd}
				@touchcancel=${cancelVStepTouchDrag}>
				<span class="wf-vstep-grip"
					@touchstart=${(e: TouchEvent) => handleVStepGripTouchStart(e, gateIdx, stepIdx)}>${icon(GripVertical, "sm")}</span>
				<span class="wf-vstep-chevron">\u25B8</span>
				<span class="wf-verify-type-icon">${icon(typeIcon, "sm")}</span>
				<span class="wf-vstep-name-label">${step.name || "(unnamed)"}</span>
				<span class="wf-vstep-sep">\u00B7</span>
				<span class="wf-vstep-type-label">${stepType}</span>
				${step.optional ? html`<span class="wf-vstep-optional-badge">optional</span>` : nothing}
				${saveAttempted && Object.keys(errs).length > 0 ? html`<span class="wf-vstep-error-badge" title="This step has validation errors">${icon(AlertCircle, "sm")}</span>` : nothing}
				<span class="wf-vstep-spacer"></span>
				<button class="wf-criteria-remove" title="Remove verification step" @click=${(e: Event) => {
					e.stopPropagation();
					const steps = (gate.verify || []).filter((_: any, i: number) => i !== stepIdx);
					updateGateField(gateIdx, "verify", steps);
				}}>${icon(Trash2, "sm")}</button>
			</div>
			<div class="wf-vstep-body">
				<div class="wf-vstep-fields">
					<div class="wf-identity-row">
						<label class="wf-field-label">Name</label>
						<input class="wf-input ${errs.name ? "wf-input-error" : ""}" data-testid="wf-step-name" style="flex:1;min-width:0;" .value=${step.name || ""} placeholder="Step name"
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => updateStep({ name: (e.target as HTMLInputElement).value })} />
						<label class="wf-field-label" style="margin-left:8px;">Type</label>
						<select class="wf-select" data-testid="wf-step-type" .value=${stepType}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${handleTypeChange}
							@change=${handleTypeChange}>
							<option value="command" ?selected=${stepType === "command"}>command</option>
							<option value="llm-review" ?selected=${stepType === "llm-review"}>llm-review</option>
							<option value="agent-qa" ?selected=${stepType === "agent-qa"}>agent-qa</option>
							<option value="human-signoff" ?selected=${stepType === "human-signoff"}>human-signoff</option>
						</select>
						${stepType === "command" ? html`
							<label class="wf-field-label" style="margin-left:8px;">Expect</label>
							<select class="wf-select" data-testid="wf-step-expect" .value=${step.expect || "success"}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => updateStep({ expect: (e.target as HTMLSelectElement).value as "success" | "failure" })}>
								<option value="success" ?selected=${step.expect !== "failure"}>success</option>
								<option value="failure" ?selected=${step.expect === "failure"}>failure</option>
							</select>
						` : nothing}
					</div>
					${errs.name ? html`<div class="wf-field-error" data-testid="wf-step-name-error">${errs.name}</div>` : nothing}

					${stepType === "command" ? html`
						<div class="wf-cmd-mode-row">
							<span class="wf-field-label">Source</span>
							<button class="wf-cmd-mode-toggle ${!useNamedCommand ? "is-active" : ""}" data-testid="wf-cmd-mode-run"
								@pointerdown=${(e: Event) => { e.stopPropagation(); setCommandMode("run"); }}
								@click=${(e: Event) => { e.stopPropagation(); setCommandMode("run"); }}>Free-form <code>run</code></button>
							<button class="wf-cmd-mode-toggle ${useNamedCommand ? "is-active" : ""}" data-testid="wf-cmd-mode-command"
								@pointerdown=${(e: Event) => { e.stopPropagation(); setCommandMode("command"); }}
								@click=${(e: Event) => { e.stopPropagation(); setCommandMode("command"); }}>Named <code>command</code></button>
						</div>
						${!useNamedCommand ? html`
							<input class="wf-input ${errs.run ? "wf-input-error" : ""}" data-testid="wf-step-run" .value=${step.run || ""} placeholder="Command to run..."
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ run: (e.target as HTMLInputElement).value })} />
							<div class="wf-field-hint">Variables: {{branch}}, {{master}}, {{cwd}}, {{project.key}}, {{agent.key}}, {{gate_id.meta.key}}</div>
							${errs.run ? html`<div class="wf-field-error" data-testid="wf-step-run-error">${errs.run}</div>` : nothing}
						` : html`
							<input class="wf-input ${errs.command ? "wf-input-error" : ""}" data-testid="wf-step-command" .value=${step.command || ""} placeholder="Named command (e.g. build, unit)"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ command: (e.target as HTMLInputElement).value })} />
							<div class="wf-field-hint">Resolves against the chosen component's <code>commands:</code> map.</div>
							${errs.command ? html`<div class="wf-field-error" data-testid="wf-step-command-error">${errs.command}</div>` : nothing}
						`}
					` : html`
						<textarea class="wf-textarea ${errs.prompt ? "wf-input-error" : ""}" data-testid="wf-step-prompt" .value=${step.prompt || ""} placeholder="${stepType === "agent-qa" ? "QA test prompt..." : stepType === "human-signoff" ? "What to ask the reviewer…" : "Review prompt..."}"
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => updateStep({ prompt: (e.target as HTMLTextAreaElement).value })}></textarea>
						${errs.prompt ? html`<div class="wf-field-error" data-testid="wf-step-prompt-error">${errs.prompt}</div>` : nothing}
					`}

					${stepType === "human-signoff" ? html`
						<div class="wf-field">
							<label class="wf-field-label">Card Title</label>
							<input class="wf-input ${errs.label ? "wf-input-error" : ""}" data-testid="wf-step-label" .value=${step.label || ""} placeholder="Approve design doc"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ label: (e.target as HTMLInputElement).value })} />
							<div class="wf-field-hint">Title shown on the sign-off request card.</div>
							${errs.label ? html`<div class="wf-field-error" data-testid="wf-step-label-error">${errs.label}</div>` : nothing}
						</div>
					` : nothing}

					<details class="wf-vstep-advanced" ?open=${!!(step.timeout || step.role || step.description || step.component || (step.phase != null && step.phase !== 0) || (saveAttempted && Object.keys(errs).length > 0))}>
						<summary class="wf-vstep-advanced-summary">Advanced</summary>
						<div class="wf-vstep-advanced-fields">
							<div class="wf-field">
								<label class="wf-field-label">Phase</label>
								<input class="wf-input" data-testid="wf-step-phase" type="number" min="0" step="1" .value=${String(step.phase ?? 0)}
									@click=${(e: Event) => e.stopPropagation()}
									@input=${(e: Event) => {
										const raw = (e.target as HTMLInputElement).value.trim();
										const n = raw === "" ? 0 : Math.max(0, Math.floor(Number(raw)));
										updateStep({ phase: Number.isFinite(n) && n > 0 ? n : undefined });
									}} />
								<div class="wf-field-hint">Steps in later phases wait for earlier phases in the same gate.</div>
							</div>
							${showTimeoutField ? html`
								<div class="wf-field">
									<label class="wf-field-label">Timeout (seconds)</label>
									<input class="wf-input" data-testid="wf-step-timeout" type="number" min="1" step="1" placeholder="300" .value=${step.timeout != null ? String(step.timeout) : ""}
										@click=${(e: Event) => e.stopPropagation()}
										@input=${(e: Event) => {
											const raw = (e.target as HTMLInputElement).value.trim();
											if (raw === "") { updateStep({ timeout: undefined }); return; }
											const n = Math.floor(Number(raw));
											if (!Number.isFinite(n) || n <= 0) { updateStep({ timeout: undefined }); return; }
											updateStep({ timeout: n });
										}} />
									<div class="wf-field-hint">Empty = built-in default. Must be a positive integer.</div>
								</div>
							` : nothing}
							${showRoleField ? html`
								<div class="wf-field">
									<label class="wf-field-label">Role</label>
									<input class="wf-input" data-testid="wf-step-role" placeholder="reviewer" .value=${step.role || ""}
										@click=${(e: Event) => e.stopPropagation()}
										@input=${(e: Event) => updateStep({ role: (e.target as HTMLInputElement).value || undefined })} />
									<div class="wf-field-hint">Agent persona used to render the step (empty = built-in default).</div>
								</div>
							` : nothing}
							${showComponentField ? html`
								<div class="wf-field">
									<label class="wf-field-label">Component</label>
									${componentOptions.length > 0 ? html`
										<select class="wf-select ${errs.component ? "wf-input-error" : ""}" data-testid="wf-step-component" .value=${step.component || ""}
											@click=${(e: Event) => e.stopPropagation()}
											@change=${(e: Event) => updateStep({ component: (e.target as HTMLSelectElement).value || undefined })}>
											<option value="" ?selected=${!step.component}>(first component)</option>
											${componentOptions.map(n => html`<option value="${n}" ?selected=${step.component === n}>${n}</option>`)}
										</select>
									` : html`
										<input class="wf-input ${errs.component ? "wf-input-error" : ""}" data-testid="wf-step-component" .value=${step.component || ""} placeholder="Component name"
											@click=${(e: Event) => e.stopPropagation()}
											@input=${(e: Event) => updateStep({ component: (e.target as HTMLInputElement).value || undefined })} />
									`}
									<div class="wf-field-hint">Required when using a named <code>command</code>; empty is valid only for free-form <code>run</code>.</div>
									${errs.component ? html`<div class="wf-field-error" data-testid="wf-step-component-error">${errs.component}</div>` : nothing}
								</div>
							` : nothing}
							<div class="wf-field">
								<label class="wf-field-label">Description</label>
								<textarea class="wf-textarea" data-testid="wf-step-description" rows="2" .value=${step.description || ""} placeholder="Free-form description (shown in tooltips and the opt-in card)"
									@click=${(e: Event) => e.stopPropagation()}
									@input=${(e: Event) => updateStep({ description: (e.target as HTMLTextAreaElement).value || undefined })}></textarea>
							</div>
						</div>
					</details>

					<div class="wf-vstep-optional-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" data-testid="wf-step-optional" .checked=${step.optional === true}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => {
									const checked = (e.target as HTMLInputElement).checked;
									const steps = currentSteps();
									steps[stepIdx] = { ...steps[stepIdx], optional: checked || undefined };
									if (!checked) {
										delete steps[stepIdx].optional;
										delete steps[stepIdx].optionalLabel;
									}
									updateGateField(gateIdx, "verify", steps);
								}} />
							<span>Optional</span>
							<span class="wf-info-icon" title="User opts in at goal-creation time">i</span>
						</label>
						${step.optional ? html`
							<input class="wf-input" data-testid="wf-step-optional-label" style="flex:1;" .value=${step.optionalLabel || ""} placeholder="Toggle label (e.g. Enable QA Testing)"
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ optionalLabel: (e.target as HTMLInputElement).value || undefined })} />
						` : nothing}
					</div>
					${step.optional ? html`<div class="wf-field-hint">Toggle label shown at goal creation.</div>` : nothing}
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
	const steps = gate.verify || [];
	const grouped = groupStepsByPhase(steps);
	const allPhases = getAllPhaseNumbers(gateIdx);

	// If no phases at all (no steps, no empty phases), just show phase 0
	if (allPhases.length === 0 && steps.length === 0) {
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
				@dragover=${(e: DragEvent) => {
					// Allow drop on empty phase body
					if (isEmpty) handleVStepDragOver(e, phase, 0);
				}}
				@drop=${handleVStepDrop}>
				<div class="wf-phase-header">
					<span>Phase ${phase}</span>
					${isEmpty && isEmptyTracked ? html`
						<button class="wf-phase-delete" title="Remove empty phase" @click=${(e: Event) => {
							e.stopPropagation();
							removeEmptyPhase(gateIdx, phase);
						}}>${icon(Trash2, "sm")}</button>
					` : nothing}
				</div>
				<div class="wf-phase-body">
					${phaseSteps.length === 0 ? html`<div class="wf-phase-empty-hint">No steps — drag here or add one</div>` : nothing}
					${phaseSteps.map((entry, posInPhase) => html`
						${vstepDropTarget && vstepDropTarget.phase === phase && vstepDropTarget.position === posInPhase && vstepDragGateIdx === gateIdx
							? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
						<div
							@dragover=${(e: DragEvent) => {
								const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
								const midY = rect.top + rect.height / 2;
								const pos = e.clientY < midY ? posInPhase : posInPhase + 1;
								handleVStepDragOver(e, phase, pos);
							}}>
							${renderVerifyStepEditor(gate, gateIdx, entry.step, entry.originalIndex)}
						</div>
					`)}
					${vstepDropTarget && vstepDropTarget.phase === phase && vstepDropTarget.position >= phaseSteps.length && vstepDragGateIdx === gateIdx
						? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
				</div>
			</div>
		`;
	})}`;
}

// ============================================================================
// RENDER: DEPENDS-ON CHIP STRIP
// ============================================================================

function renderDependsOnEditor(gate: WorkflowGate, idx: number): TemplateResult {
	const others = editGates
		.map((g, i) => ({ g, i }))
		.filter(({ g, i }) => i !== idx && g.id && g.id.trim().length > 0);
	const current = new Set(gate.dependsOn || []);
	return html`
		<div class="wf-field">
			<label class="wf-field-label">Depends on</label>
			<div class="wf-dep-list" data-testid="wf-gate-depends-on">
				${others.length === 0 ? html`
					<span class="wf-dep-none">No other gates with IDs yet.</span>
				` : others.map(({ g }) => {
					const active = current.has(g.id);
					return html`
						<button class="wf-dep-toggle-chip ${active ? "wf-dep-toggle-chip--active" : ""}"
							data-testid="wf-dep-chip-${g.id}"
							@click=${(e: Event) => {
								e.stopPropagation();
								const next = new Set(current);
								if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
								updateGateField(idx, "dependsOn", [...next]);
							}}>${g.id}</button>
					`;
				})}
			</div>
			<div class="wf-field-hint">This gate depends only on the selected gates. Select none to make it an independent root/parallel gate.</div>
		</div>
	`;
}

// ============================================================================
// RENDER: METADATA KEY-VALUE EDITOR
// ============================================================================

/** Persist draft rows back into `gate.metadata` (stripping blank keys). */
function commitMetadataRows(idx: number, rows: Array<[string, string]>, rerender = false): void {
	metadataDrafts.set(idx, rows);
	const rec: Record<string, string> = {};
	for (const [k, v] of rows) {
		const trimmed = k.trim();
		if (trimmed) rec[trimmed] = v;
	}
	const nextGates = [...editGates];
	const nextGate = { ...nextGates[idx], metadata: Object.keys(rec).length > 0 ? rec : undefined };
	nextGates[idx] = nextGate;
	editGates = nextGates;
	if (rerender) renderApp();
}

function renderMetadataEditor(gate: WorkflowGate, idx: number): TemplateResult {
	let rows = metadataDrafts.get(idx);
	if (!rows) {
		rows = gate.metadata ? Object.entries(gate.metadata).map(([k, v]) => [k, v] as [string, string]) : [];
		metadataDrafts.set(idx, rows);
	}

	return html`
		<div class="wf-field">
			<label class="wf-field-label">Metadata</label>
			<div class="wf-metadata-list" data-testid="wf-gate-metadata">
				${rows.length === 0 ? html`<div class="wf-dep-none">No metadata entries.</div>` : rows.map(([k, v], rowIdx) => html`
					<div class="wf-metadata-row" data-testid="wf-metadata-row">
						<input class="wf-input" data-testid="wf-metadata-key" placeholder="key" .value=${k}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								// Read the latest draft rows instead of the render-time closure. Input
								// events across adjacent key/value fields can fire before the previous
								// render has swapped listeners, and using the stale `rows` closure would
								// clobber a just-entered sibling value.
								const currentRows = metadataDrafts.get(idx) || rows!;
								const next: Array<[string, string]> = currentRows.map((p, i) => i === rowIdx ? [(e.target as HTMLInputElement).value, p[1]] : p);
								commitMetadataRows(idx, next);
							}} />
						<input class="wf-input" data-testid="wf-metadata-value" placeholder="value" .value=${v}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								const currentRows = metadataDrafts.get(idx) || rows!;
								const next: Array<[string, string]> = currentRows.map((p, i) => i === rowIdx ? [p[0], (e.target as HTMLInputElement).value] : p);
								commitMetadataRows(idx, next);
							}} />
						<button class="wf-criteria-remove" title="Remove metadata entry" data-testid="wf-metadata-remove" @click=${(e: Event) => {
							e.stopPropagation();
							const currentRows = metadataDrafts.get(idx) || rows!;
							const next: Array<[string, string]> = currentRows.filter((_, i) => i !== rowIdx);
							commitMetadataRows(idx, next, true);
						}}>${icon(Trash2, "sm")}</button>
					</div>
				`)}
			</div>
			<button class="wf-criteria-add-btn" data-testid="wf-metadata-add" @click=${(e: Event) => {
				e.stopPropagation();
				const currentRows = metadataDrafts.get(idx) || rows || [];
				const next: Array<[string, string]> = [...currentRows, ["", ""]];
				commitMetadataRows(idx, next, true);
			}}>Add metadata</button>
			<div class="wf-field-hint">Free-form key/value pairs (used by some workflows for routing).</div>
		</div>
	`;
}

// ============================================================================
// RENDER: GATE EDITOR (collapsible card)
// ============================================================================

function renderGateEditor(gate: WorkflowGate, idx: number): TemplateResult {
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
				<span class="wf-gate-chevron">\u25B8</span>
				<span class="wf-gate-name">${gate.name || "(unnamed)"}</span>
				${verifySummary ? html`<span class="wf-gate-pill">${verifySummary}</span>` : nothing}
				<button class="wf-gate-delete" @click=${(e: Event) => { e.stopPropagation(); removeGate(idx); }} title="Remove gate">${icon(Trash2, "sm")}</button>
			</div>

			<div class="wf-gate-body">
				<div class="wf-gate-body-inner">
					<div class="wf-identity-row">
						<label class="wf-field-label">ID</label>
						<input class="wf-input" data-testid="wf-gate-id" style="width:140px;" .value=${gate.id} placeholder="e.g. issue-analysis"
							@input=${(e: Event) => updateGateField(idx, "id", (e.target as HTMLInputElement).value)} />
						<label class="wf-field-label" style="margin-left:8px;">Name</label>
						<input class="wf-input" data-testid="wf-gate-name" style="flex:1;min-width:0;" .value=${gate.name} placeholder="Display name"
							@input=${(e: Event) => updateGateField(idx, "name", (e.target as HTMLInputElement).value)} />
					</div>

					<div class="wf-toggles-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-content" .checked=${gate.content === true}
								@change=${(e: Event) => updateGateField(idx, "content", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Content</span>
							<span class="wf-info-icon" title="Content gates store a markdown document">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-inject-downstream" .checked=${gate.injectDownstream === true}
								@change=${(e: Event) => updateGateField(idx, "injectDownstream", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Inject downstream</span>
							<span class="wf-info-icon" title="Agents working towards subsequent gates have the content attached to this gate injected into their context">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-optional" .checked=${gate.optional === true}
								@change=${(e: Event) => updateGateField(idx, "optional", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Optional</span>
							<span class="wf-info-icon" title="Whole gate is skippable for the goal">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-manual" .checked=${gate.manual === true}
								@change=${(e: Event) => updateGateField(idx, "manual", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Manual</span>
							<span class="wf-info-icon" title="Don't auto-verify on signal; require an explicit human signal. (Different from a human-signoff step type — manual gates have no per-step approval UI.)">i</span>
						</label>
					</div>

					${renderDependsOnEditor(gate, idx)}

					${renderMetadataEditor(gate, idx)}

					<div class="wf-field">
						<span class="wf-verify-label">Verification Steps (${verifyCount})</span>
						<div class="wf-verification-steps">
							${renderPhaseGroups(gate, idx)}
							<div class="wf-phase-actions">
								<button class="wf-criteria-add-btn" title="Add verification step" @click=${(e: Event) => {
									e.stopPropagation();
									const steps = [...(gate.verify || []), { name: "", type: "command" as const, run: "" }];
									updateGateField(idx, "verify", steps);
								}}>Add Step</button>
								<button class="wf-criteria-add-btn wf-add-phase-btn" title="Add a new phase" @click=${(e: Event) => {
									e.stopPropagation();
									addPhase(idx);
								}}>Add Phase</button>
							</div>
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
	return html`
		<div class="wf-edit-container">
			${saveBlockedReason ? html`
				<div class="wf-save-error-banner" data-testid="wf-save-error-banner" role="alert">
					${icon(AlertCircle, "sm")}
					<span>${saveBlockedReason}</span>
				</div>
			` : nothing}
			<div class="wf-edit-identity">
				<div class="flex items-center justify-between mb-1">
					<span>${selectedWorkflow ? renderOriginBadge((selectedWorkflow as any).origin, (selectedWorkflow as any).overrides) : ""}</span>
					${renderCustomizeRevertButtons()}
				</div>
				<div class="wf-identity-row">
					<label class="wf-field-label">ID</label>
					${isNew ? html`
						<input class="wf-input" style="width:140px;" .value=${editId} placeholder="e.g. bug-fix"
							@input=${(e: Event) => { editId = (e.target as HTMLInputElement).value; renderApp(); }} />
					` : html`
						<input class="wf-input" style="width:140px;opacity:0.6;cursor:not-allowed;" .value=${editId} disabled />
					`}
					<label class="wf-field-label" style="margin-left:8px;">Name</label>
					<input class="wf-input" style="flex:1;min-width:0;" .value=${editName} placeholder="Workflow name"
						@input=${(e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); }} />
				</div>
				<div class="wf-identity-row">
					<label class="wf-field-label" style="flex-shrink:0;">Description</label>
					<textarea class="wf-textarea wf-desc-auto" rows="1" .value=${editDescription} placeholder="What this workflow does"
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; autoGrowTextarea(e.target as HTMLTextAreaElement); }}></textarea>
				</div>
			</div>

			<div class="wf-artifacts-list">
				${editGates.map((gate, idx) => renderGateEditor(gate, idx))}
				${Button({
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
