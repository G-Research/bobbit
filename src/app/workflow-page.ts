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
// EDITOR INSTANCES — one per render surface
//
// Each surface that needs to render an editor or inspector owns its own
// `EditorInstance`. The main Workflows page owns `pageInstance`; embeds
// (e.g. the goal-proposal modal Workflow tab) get their own instance keyed
// by `workflowKey`. Because every action/render function takes an `inst`
// parameter and the event handlers in the templates close over that
// parameter, two visible editors (page + modal) never clobber each other.
// ============================================================================

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

interface EditorInstance {
	// Identity / mode
	id: string;
	controller: EditorController | null;
	// Form fields
	editId: string;
	editName: string;
	editDescription: string;
	editGates: WorkflowGate[];
	// Page-shell-only fields (only meaningful for `pageInstance`)
	selectedWorkflow: Workflow | null;
	isNew: boolean;
	saving: boolean;
	// Expansion / drag state
	expandedGateIndices: Set<number>;
	expandedVStepKeys: Set<string>;
	dragIndex: number | null;
	dropTargetIndex: number | null;
	vstepDragGateIdx: number | null;
	vstepDragStepIdx: number | null;
	vstepDropTarget: { phase: number; position: number } | null;
	emptyPhases: Map<number, Set<number>>;
	// Touch drag transients
	touchLongPressTimer: ReturnType<typeof setTimeout> | null;
	touchStartY: number;
	touchDragging: boolean;
	vstepTouchLongPressTimer: ReturnType<typeof setTimeout> | null;
	vstepTouchDragging: boolean;
}

function makeInstance(id: string): EditorInstance {
	return {
		id,
		controller: null,
		editId: "",
		editName: "",
		editDescription: "",
		editGates: [],
		selectedWorkflow: null,
		isNew: false,
		saving: false,
		expandedGateIndices: new Set(),
		expandedVStepKeys: new Set(),
		dragIndex: null,
		dropTargetIndex: null,
		vstepDragGateIdx: null,
		vstepDragStepIdx: null,
		vstepDropTarget: null,
		emptyPhases: new Map(),
		touchLongPressTimer: null,
		touchStartY: 0,
		touchDragging: false,
		vstepTouchLongPressTimer: null,
		vstepTouchDragging: false,
	};
}

// Canonical page-level editor instance. Owned by the Workflows page shell.
const pageInstance: EditorInstance = makeInstance("__page__");

// Embed instances keyed by `workflowKey` (e.g. `__inspector__:bug-fix`,
// `__editor__:bug-fix`). Embeds keep their own state across re-renders so
// the modal can preserve expansion / draft edits without touching the
// page.
const embedInstances = new Map<string, EditorInstance>();

function getOrCreateEmbedInstance(workflowKey: string): EditorInstance {
	let inst = embedInstances.get(workflowKey);
	if (!inst) {
		inst = makeInstance(workflowKey);
		embedInstances.set(workflowKey, inst);
	}
	return inst;
}

function isReadOnly(inst: EditorInstance): boolean {
	return inst.controller?.readOnly === true;
}

// ============================================================================
// PAGE-SHELL STATE (list view + navigation — not per-editor)
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let workflows: Workflow[] = [];
let loading = true;

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

function resetPageInstance(): void {
	pageInstance.controller = null;
	pageInstance.editId = "";
	pageInstance.editName = "";
	pageInstance.editDescription = "";
	pageInstance.editGates = [];
	pageInstance.selectedWorkflow = null;
	pageInstance.isNew = false;
	pageInstance.saving = false;
	pageInstance.expandedGateIndices = new Set();
	pageInstance.expandedVStepKeys = new Set();
	pageInstance.dragIndex = null;
	pageInstance.dropTargetIndex = null;
	pageInstance.vstepDragGateIdx = null;
	pageInstance.vstepDragStepIdx = null;
	pageInstance.vstepDropTarget = null;
	pageInstance.emptyPhases = new Map();
}

export async function loadWorkflowPageData(): Promise<void> {
	currentView = "list";
	loading = true;
	resetPageInstance();
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
	loading = true;
	resetPageInstance();
}

// ============================================================================
// NAVIGATION (page shell only)
// ============================================================================

function showList(): void {
	currentView = "list";
	resetPageInstance();
	setHashRoute("workflows");
}

function showEdit(workflow: Workflow): void {
	currentView = "edit";
	pageInstance.controller = null;
	pageInstance.selectedWorkflow = workflow;
	pageInstance.isNew = false;
	pageInstance.editId = workflow.id;
	pageInstance.editName = workflow.name;
	pageInstance.editDescription = workflow.description;
	pageInstance.editGates = workflow.gates.map((g) => ({ ...g, dependsOn: [...g.dependsOn], verify: g.verify ? g.verify.map(v => ({ ...v })) : undefined, metadata: g.metadata ? { ...g.metadata } : undefined }));
	pageInstance.saving = false;
	pageInstance.expandedGateIndices = new Set();
	pageInstance.expandedVStepKeys = new Set();
	saveAttempted = false;
	saveBlockedReason = null;
	seedMetadataDrafts(pageInstance.editGates);
	void loadProjectComponentsForEditor();
	setHashRoute("workflow-edit", workflow.id);
}

function showNewEdit(): void {
	currentView = "edit";
	pageInstance.controller = null;
	pageInstance.selectedWorkflow = null;
	pageInstance.isNew = true;
	pageInstance.editId = "";
	pageInstance.editName = "";
	pageInstance.editDescription = "";
	pageInstance.editGates = [];
	pageInstance.saving = false;
	pageInstance.expandedGateIndices = new Set();
	pageInstance.expandedVStepKeys = new Set();
	saveAttempted = false;
	saveBlockedReason = null;
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
		pageInstance.selectedWorkflow = null;
	}
	renderApp();
}

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

function getAllPhaseNumbers(inst: EditorInstance, gateIdx: number): number[] {
	const steps = inst.editGates[gateIdx].verify || [];
	const stepPhases = new Set(steps.map(s => s.phase ?? 0));
	const empty = inst.emptyPhases.get(gateIdx) || new Set();
	for (const p of empty) stepPhases.add(p);
	return [...stepPhases].sort((a, b) => a - b);
}

function addPhase(inst: EditorInstance, gateIdx: number): void {
	const phases = getAllPhaseNumbers(inst, gateIdx);
	const next = phases.length > 0 ? Math.max(...phases) + 1 : 1;
	if (!inst.emptyPhases.has(gateIdx)) inst.emptyPhases.set(gateIdx, new Set());
	inst.emptyPhases.get(gateIdx)!.add(next);
	renderApp();
}

function removeEmptyPhase(inst: EditorInstance, gateIdx: number, phase: number): void {
	const ep = inst.emptyPhases.get(gateIdx);
	if (ep) { ep.delete(phase); }
	renderApp();
}

// ============================================================================
// VSTEP DRAG-AND-DROP
// ============================================================================

function moveVerifyStep(inst: EditorInstance, gateIdx: number, fromStepIdx: number, toPhase: number, toPosition: number): void {
	const steps = [...(inst.editGates[gateIdx].verify || [])];
	const [moved] = steps.splice(fromStepIdx, 1);
	moved.phase = toPhase;
	const targetPhaseSteps = steps.filter(s => (s.phase ?? 0) === toPhase);
	let insertAt: number;
	if (toPosition < targetPhaseSteps.length) {
		insertAt = steps.indexOf(targetPhaseSteps[toPosition]);
	} else {
		if (targetPhaseSteps.length > 0) {
			insertAt = steps.indexOf(targetPhaseSteps[targetPhaseSteps.length - 1]) + 1;
		} else {
			insertAt = steps.length;
		}
	}
	steps.splice(insertAt, 0, moved);
	updateGateField(inst, gateIdx, "verify", steps);
}

function handleVStepDragStart(inst: EditorInstance, e: DragEvent, gateIdx: number, stepIdx: number): void {
	inst.vstepDragGateIdx = gateIdx;
	inst.vstepDragStepIdx = stepIdx;
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/x-vstep", `${gateIdx}:${stepIdx}`);
	}
	renderApp();
}

function handleVStepDragOver(inst: EditorInstance, e: DragEvent, phase: number, position: number): void {
	e.preventDefault();
	e.stopPropagation();
	if (inst.vstepDragGateIdx === null) return;
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	const newTarget = { phase, position };
	if (!inst.vstepDropTarget || inst.vstepDropTarget.phase !== newTarget.phase || inst.vstepDropTarget.position !== newTarget.position) {
		inst.vstepDropTarget = newTarget;
		renderApp();
	}
}

function handleVStepDrop(inst: EditorInstance, e: DragEvent): void {
	e.preventDefault();
	e.stopPropagation();
	if (inst.vstepDragGateIdx !== null && inst.vstepDragStepIdx !== null && inst.vstepDropTarget !== null) {
		moveVerifyStep(inst, inst.vstepDragGateIdx, inst.vstepDragStepIdx, inst.vstepDropTarget.phase, inst.vstepDropTarget.position);
	}
	inst.vstepDragGateIdx = null;
	inst.vstepDragStepIdx = null;
	inst.vstepDropTarget = null;
	renderApp();
}

function handleVStepDragEnd(inst: EditorInstance): void {
	inst.vstepDragGateIdx = null;
	inst.vstepDragStepIdx = null;
	inst.vstepDropTarget = null;
	renderApp();
}

function cancelVStepTouchDrag(inst: EditorInstance): void {
	if (inst.vstepTouchLongPressTimer) { clearTimeout(inst.vstepTouchLongPressTimer); inst.vstepTouchLongPressTimer = null; }
	if (inst.vstepTouchDragging || inst.vstepDragGateIdx !== null) {
		inst.vstepTouchDragging = false;
		inst.vstepDragGateIdx = null;
		inst.vstepDragStepIdx = null;
		inst.vstepDropTarget = null;
		renderApp();
	}
}

function vstepTouchDropTarget(inst: EditorInstance, clientY: number, gateIdx: number): { phase: number; position: number } | null {
	const phaseGroups = document.querySelectorAll(`.wf-phase-group[data-gate-idx="${gateIdx}"]`);
	for (const group of phaseGroups) {
		const phase = parseInt(group.getAttribute("data-phase") || "0", 10);
		const cards = group.querySelectorAll(".wf-vstep-card");
		for (let i = 0; i < cards.length; i++) {
			const rect = cards[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return { phase, position: i };
		}
		const groupRect = group.getBoundingClientRect();
		if (clientY < groupRect.bottom) return { phase, position: cards.length };
	}
	const phases = getAllPhaseNumbers(inst, gateIdx);
	const lastPhase = phases.length > 0 ? phases[phases.length - 1] : 0;
	return { phase: lastPhase, position: 999 };
}

function startVStepTouchDrag(inst: EditorInstance, gateIdx: number, stepIdx: number): void {
	inst.vstepTouchDragging = true;
	inst.vstepDragGateIdx = gateIdx;
	inst.vstepDragStepIdx = stepIdx;
	renderApp();
}

function handleVStepGripTouchStart(inst: EditorInstance, e: TouchEvent, gateIdx: number, stepIdx: number): void {
	e.preventDefault();
	e.stopPropagation();
	startVStepTouchDrag(inst, gateIdx, stepIdx);
}

function handleVStepHeaderTouchStart(inst: EditorInstance, e: TouchEvent, gateIdx: number, stepIdx: number): void {
	const touch = e.touches[0];
	const startY = touch.clientY;
	const startX = touch.clientX;
	inst.vstepTouchLongPressTimer = setTimeout(() => {
		inst.vstepTouchLongPressTimer = null;
		startVStepTouchDrag(inst, gateIdx, stepIdx);
	}, 500);
	const moveCancel = (ev: TouchEvent) => {
		const t = ev.touches[0];
		if (Math.abs(t.clientY - startY) > 10 || Math.abs(t.clientX - startX) > 10) {
			if (inst.vstepTouchLongPressTimer) { clearTimeout(inst.vstepTouchLongPressTimer); inst.vstepTouchLongPressTimer = null; }
			document.removeEventListener("touchmove", moveCancel);
		}
	};
	document.addEventListener("touchmove", moveCancel, { passive: true });
}

function handleVStepTouchMove(inst: EditorInstance, e: TouchEvent): void {
	if (!inst.vstepTouchDragging || inst.vstepDragGateIdx === null) return;
	e.preventDefault();
	const touch = e.touches[0];
	const target = vstepTouchDropTarget(inst, touch.clientY, inst.vstepDragGateIdx);
	if (target && (!inst.vstepDropTarget || inst.vstepDropTarget.phase !== target.phase || inst.vstepDropTarget.position !== target.position)) {
		inst.vstepDropTarget = target;
		renderApp();
	}
}

function handleVStepTouchEnd(inst: EditorInstance): void {
	if (inst.vstepTouchLongPressTimer) { clearTimeout(inst.vstepTouchLongPressTimer); inst.vstepTouchLongPressTimer = null; }
	if (!inst.vstepTouchDragging || inst.vstepDragGateIdx === null) return;
	if (inst.vstepDragStepIdx !== null && inst.vstepDropTarget !== null) {
		moveVerifyStep(inst, inst.vstepDragGateIdx, inst.vstepDragStepIdx, inst.vstepDropTarget.phase, inst.vstepDropTarget.position);
	}
	inst.vstepTouchDragging = false;
	inst.vstepDragGateIdx = null;
	inst.vstepDragStepIdx = null;
	inst.vstepDropTarget = null;
	renderApp();
}

// ============================================================================
// SAVE / DELETE (page shell only — operates on pageInstance)
// ============================================================================

async function handleSave(): Promise<void> {
	saveAttempted = true;
	saveBlockedReason = null;

	// Run validation before persisting. Block save on any error and surface
	// inline messages in the editor + a top-level banner.
	const issues = collectValidationErrors(pageInstance.editGates);
	if (issues.length > 0) {
		// Expand any gates that contain an invalid step so the user can see the
		// inline error without hunting for it.
		for (const { gateIdx, stepIdx } of issues) {
			pageInstance.expandedGateIndices.add(gateIdx);
			pageInstance.expandedVStepKeys.add(`${gateIdx}-${stepIdx}`);
		}
		saveBlockedReason = `${issues.length} verification step${issues.length === 1 ? "" : "s"} ha${issues.length === 1 ? "s" : "ve"} validation errors. Fix them and try again.`;
		pageInstance.saving = false;
		renderApp();
		return;
	}

	pageInstance.saving = true;
	renderApp();

	// Compact phases before saving
	const compacted = compactPhases(pageInstance.editGates);

	// Preserve the explicit DAG exactly as edited. `dependsOn: []` is a valid
	// YAML shape for root/parallel gates; do not silently rewrite it to a linear
	// previous-gate dependency on save.
	const gatesWithDeps = compacted.map(g => ({ ...g, dependsOn: g.dependsOn || [] }));

	if (pageInstance.isNew) {
		const result = await createWorkflow({
			id: pageInstance.editId,
			name: pageInstance.editName,
			description: pageInstance.editDescription,
			gates: gatesWithDeps,
		}, getConfigProjectId() || undefined);
		if (result) {
			workflows = await fetchWorkflowsScoped();
			showEdit(result);
			return;
		}
	} else if (pageInstance.selectedWorkflow) {
		const ok = await updateWorkflow(pageInstance.selectedWorkflow.id, {
			name: pageInstance.editName,
			description: pageInstance.editDescription,
			gates: gatesWithDeps,
		}, getConfigProjectId() || undefined);
		if (ok) {
			workflows = await fetchWorkflowsScoped();
			const updated = workflows.find((w) => w.id === pageInstance.selectedWorkflow!.id);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	pageInstance.saving = false;
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
		if (pageInstance.selectedWorkflow?.id === workflow.id) {
			showList();
		}
		renderApp();
	}
}

// ============================================================================
// EDITOR MUTATIONS — operate on a specific instance
// ============================================================================

function addGate(inst: EditorInstance): void {
	inst.editGates = [...inst.editGates, {
		id: "",
		name: "",
		dependsOn: [],
	}];
	inst.expandedGateIndices.add(inst.editGates.length - 1);
	notifyControlledChange(inst);
	renderApp();
}

function removeGate(inst: EditorInstance, index: number): void {
	inst.editGates = inst.editGates.filter((_, i) => i !== index);
	const newExpanded = new Set<number>();
	for (const idx of inst.expandedGateIndices) {
		if (idx < index) newExpanded.add(idx);
		else if (idx > index) newExpanded.add(idx - 1);
	}
	inst.expandedGateIndices = newExpanded;
	// Remap metadata drafts so they stay aligned with gate indices.
	const nextDrafts: Map<number, Array<[string, string]>> = new Map();
	for (const [i, rows] of metadataDrafts) {
		if (i < index) nextDrafts.set(i, rows);
		else if (i > index) nextDrafts.set(i - 1, rows);
	}
	metadataDrafts = nextDrafts;
	notifyControlledChange(inst);
	renderApp();
}

function updateGateField(inst: EditorInstance, index: number, field: string, value: any): void {
	inst.editGates = inst.editGates.map((g, i) => i === index ? { ...g, [field]: value } : g);
	notifyControlledChange(inst);
	renderApp();
}

// Build the current draft and notify the controller (if any).
function notifyControlledChange(inst: EditorInstance): void {
	if (!inst.controller) return;
	const draft: Workflow = {
		id: inst.editId,
		name: inst.editName,
		description: inst.editDescription,
		gates: inst.editGates.map((g) => ({
			...g,
			dependsOn: [...g.dependsOn],
			verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
			metadata: g.metadata ? { ...g.metadata } : undefined,
		})),
	} as Workflow;
	try { inst.controller.onChange(draft); } catch { /* ignore controller errors */ }
}

function toggleGateExpand(inst: EditorInstance, index: number): void {
	if (inst.expandedGateIndices.has(index)) {
		inst.expandedGateIndices.delete(index);
	} else {
		inst.expandedGateIndices.add(index);
	}
	renderApp();
}

function toggleVStepExpand(inst: EditorInstance, gateIdx: number, stepIdx: number): void {
	const key = `${gateIdx}-${stepIdx}`;
	if (inst.expandedVStepKeys.has(key)) {
		inst.expandedVStepKeys.delete(key);
	} else {
		inst.expandedVStepKeys.add(key);
	}
	renderApp();
}

// ============================================================================
// GATE DRAG-TO-REORDER
// ============================================================================

function moveGate(inst: EditorInstance, fromIdx: number, toIdx: number): void {
	if (fromIdx === toIdx) return;
	const newGates = [...inst.editGates];
	const [moved] = newGates.splice(fromIdx, 1);
	newGates.splice(toIdx, 0, moved);
	inst.editGates = newGates;
	notifyControlledChange(inst);

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
	for (const idx of inst.expandedGateIndices) newExpanded.add(remap(idx));
	inst.expandedGateIndices = newExpanded;

	const nextDrafts: Map<number, Array<[string, string]>> = new Map();
	for (const [i, rows] of metadataDrafts) nextDrafts.set(remap(i), rows);
	metadataDrafts = nextDrafts;

	renderApp();
}

function handleDragStart(inst: EditorInstance, e: DragEvent, index: number): void {
	inst.dragIndex = index;
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(index));
	}
	renderApp();
}

function handleDragOver(inst: EditorInstance, e: DragEvent, index: number): void {
	e.preventDefault();
	if (inst.dragIndex === null) return;
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const midY = rect.top + rect.height / 2;
	const newTarget = e.clientY < midY ? index : index + 1;

	if (newTarget !== inst.dropTargetIndex) {
		inst.dropTargetIndex = newTarget;
		renderApp();
	}
}

function handleDrop(inst: EditorInstance, e: DragEvent): void {
	e.preventDefault();
	if (inst.dragIndex !== null && inst.dropTargetIndex !== null) {
		const to = inst.dropTargetIndex > inst.dragIndex ? inst.dropTargetIndex - 1 : inst.dropTargetIndex;
		moveGate(inst, inst.dragIndex, to);
	}
	inst.dragIndex = null;
	inst.dropTargetIndex = null;
	renderApp();
}

function handleDragEnd(inst: EditorInstance): void {
	inst.dragIndex = null;
	inst.dropTargetIndex = null;
	renderApp();
}

// ============================================================================
// TOUCH DRAG-TO-REORDER
// ============================================================================

function cancelTouchDrag(inst: EditorInstance): void {
	if (inst.touchLongPressTimer) { clearTimeout(inst.touchLongPressTimer); inst.touchLongPressTimer = null; }
	if (inst.touchDragging || inst.dragIndex !== null) {
		inst.touchDragging = false;
		inst.dragIndex = null;
		inst.dropTargetIndex = null;
		renderApp();
	}
}

function touchDropTarget(clientY: number): number | null {
	const cards = document.querySelectorAll(".wf-gate-card");
	for (let i = 0; i < cards.length; i++) {
		const rect = cards[i].getBoundingClientRect();
		if (clientY < rect.top + rect.height / 2) return i;
	}
	return cards.length;
}

function startTouchDrag(inst: EditorInstance, index: number, clientY: number): void {
	inst.touchDragging = true;
	inst.dragIndex = index;
	inst.touchStartY = clientY;
	inst.dropTargetIndex = index;
	renderApp();
}

function handleGripTouchStart(inst: EditorInstance, e: TouchEvent, index: number): void {
	e.preventDefault();
	e.stopPropagation();
	const touch = e.touches[0];
	startTouchDrag(inst, index, touch.clientY);
}

function handleHeaderTouchStart(inst: EditorInstance, e: TouchEvent, index: number): void {
	const touch = e.touches[0];
	inst.touchStartY = touch.clientY;
	const startX = touch.clientX;
	inst.touchLongPressTimer = setTimeout(() => {
		inst.touchLongPressTimer = null;
		startTouchDrag(inst, index, touch.clientY);
	}, 500);
	const moveCancel = (ev: TouchEvent) => {
		const t = ev.touches[0];
		if (Math.abs(t.clientY - inst.touchStartY) > 10 || Math.abs(t.clientX - startX) > 10) {
			if (inst.touchLongPressTimer) { clearTimeout(inst.touchLongPressTimer); inst.touchLongPressTimer = null; }
			document.removeEventListener("touchmove", moveCancel);
		}
	};
	document.addEventListener("touchmove", moveCancel, { passive: true });
}

function handleTouchMove(inst: EditorInstance, e: TouchEvent): void {
	if (!inst.touchDragging || inst.dragIndex === null) return;
	e.preventDefault();
	const touch = e.touches[0];
	const target = touchDropTarget(touch.clientY);
	if (target !== null && target !== inst.dropTargetIndex) {
		inst.dropTargetIndex = target;
		renderApp();
	}
}

function handleTouchEnd(inst: EditorInstance): void {
	if (inst.touchLongPressTimer) { clearTimeout(inst.touchLongPressTimer); inst.touchLongPressTimer = null; }
	if (!inst.touchDragging || inst.dragIndex === null) return;
	if (inst.dragIndex !== null && inst.dropTargetIndex !== null) {
		const to = inst.dropTargetIndex > inst.dragIndex ? inst.dropTargetIndex - 1 : inst.dropTargetIndex;
		moveGate(inst, inst.dragIndex, to);
	}
	inst.touchDragging = false;
	inst.dragIndex = null;
	inst.dropTargetIndex = null;
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

function renderVerifyStepEditor(inst: EditorInstance, gate: WorkflowGate, gateIdx: number, step: VerifyStep, stepIdx: number): TemplateResult {
	const readOnly = isReadOnly(inst);
	const typeIcon = stepTypeIcon(step.type);
	const isVStepExpanded = inst.expandedVStepKeys.has(`${gateIdx}-${stepIdx}`);
	const isDragging = inst.vstepDragGateIdx === gateIdx && inst.vstepDragStepIdx === stepIdx;
	const errs = saveAttempted ? validateStep(step) : {};

	const currentSteps = (): VerifyStep[] => [...(((inst.editGates[gateIdx] || gate).verify) || [])];
	const updateStep = (patch: Partial<VerifyStep>, rerender = false) => {
		// Read from the latest editGates state, not the render-time `gate` closure.
		// Most text inputs do not need a full app render on every keystroke; avoiding
		// that rerender keeps the focused DOM node stable and prevents rapid adjacent
		// edits from racing a stale render that clobbers sibling fields. Structural
		// edits (type switches, optional toggles, command-mode toggles) still call
		// updateGateField below because their visible controls change.
		const nextGates = [...inst.editGates];
		const nextGate = { ...(nextGates[gateIdx] || gate) };
		const steps = [...(nextGate.verify || [])];
		steps[stepIdx] = { ...steps[stepIdx], ...patch };
		nextGate.verify = steps;
		nextGates[gateIdx] = nextGate;
		inst.editGates = nextGates;
		notifyControlledChange(inst);
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
		updateGateField(inst, gateIdx, "verify", steps);
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
		updateGateField(inst, gateIdx, "verify", steps);
	};

	// `command` step ships two mutually-exclusive ways to specify the command:
	//   - free-form `run` string (with template variables)
	//   - structural ref to a named `command` on the chosen `component`
	const useNamedCommand = stepType === "command" && step.command !== undefined;

	const vstepClasses = [
		"wf-vstep-card",
		isVStepExpanded ? "vstep-expanded" : "",
		isDragging ? "vstep-dragging" : "",
		readOnly ? "wf-vstep-readonly" : "",
	].filter(Boolean).join(" ");
	return html`
		<div class=${vstepClasses}
			data-testid="wf-vstep-card"
			data-step-type="${stepType}"
			draggable=${readOnly ? "false" : "true"}
			@dragstart=${readOnly ? undefined : (e: DragEvent) => { e.stopPropagation(); handleVStepDragStart(inst, e, gateIdx, stepIdx); }}
			@dragend=${readOnly ? undefined : () => handleVStepDragEnd(inst)}>
			<div class="wf-vstep-collapsed-header"
				@click=${(e: Event) => { e.stopPropagation(); toggleVStepExpand(inst, gateIdx, stepIdx); }}
				@touchstart=${readOnly ? undefined : (e: TouchEvent) => handleVStepHeaderTouchStart(inst, e, gateIdx, stepIdx)}
				@touchmove=${readOnly ? undefined : (e: TouchEvent) => handleVStepTouchMove(inst, e)}
				@touchend=${readOnly ? undefined : () => handleVStepTouchEnd(inst)}
				@touchcancel=${readOnly ? undefined : () => cancelVStepTouchDrag(inst)}>
				${readOnly ? nothing : html`<span class="wf-vstep-grip"
					@touchstart=${(e: TouchEvent) => handleVStepGripTouchStart(inst, e, gateIdx, stepIdx)}>${icon(GripVertical, "sm")}</span>`}
				<span class="wf-vstep-chevron">\u25B8</span>
				<span class="wf-verify-type-icon">${icon(typeIcon, "sm")}</span>
				<span class="wf-vstep-name-label">${step.name || "(unnamed)"}</span>
				<span class="wf-vstep-sep">\u00B7</span>
				<span class="wf-vstep-type-label">${stepType}</span>
				${step.optional ? html`<span class="wf-vstep-optional-badge">optional</span>` : nothing}
				${saveAttempted && Object.keys(errs).length > 0 ? html`<span class="wf-vstep-error-badge" title="This step has validation errors">${icon(AlertCircle, "sm")}</span>` : nothing}
				<span class="wf-vstep-spacer"></span>
				${readOnly ? nothing : html`<button class="wf-criteria-remove" title="Remove verification step" @click=${(e: Event) => {
					e.stopPropagation();
					const steps = (gate.verify || []).filter((_: any, i: number) => i !== stepIdx);
					updateGateField(inst, gateIdx, "verify", steps);
				}}>${icon(Trash2, "sm")}</button>`}
			</div>
			<div class="wf-vstep-body">
				<div class="wf-vstep-fields">
					<div class="wf-identity-row">
						<label class="wf-field-label">Name</label>
						<input class="wf-input ${errs.name ? "wf-input-error" : ""}" data-testid="wf-step-name" style="flex:1;min-width:0;" .value=${step.name || ""} placeholder="Step name"
							?disabled=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => updateStep({ name: (e.target as HTMLInputElement).value })} />
						<label class="wf-field-label" style="margin-left:8px;">Type</label>
						<select class="wf-select" data-testid="wf-step-type" .value=${stepType}
							?disabled=${readOnly}
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
								?disabled=${readOnly}
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
								?disabled=${readOnly}
								@pointerdown=${readOnly ? undefined : (e: Event) => { e.stopPropagation(); setCommandMode("run"); }}
								@click=${readOnly ? undefined : (e: Event) => { e.stopPropagation(); setCommandMode("run"); }}>Free-form <code>run</code></button>
							<button class="wf-cmd-mode-toggle ${useNamedCommand ? "is-active" : ""}" data-testid="wf-cmd-mode-command"
								?disabled=${readOnly}
								@pointerdown=${readOnly ? undefined : (e: Event) => { e.stopPropagation(); setCommandMode("command"); }}
								@click=${readOnly ? undefined : (e: Event) => { e.stopPropagation(); setCommandMode("command"); }}>Named <code>command</code></button>
						</div>
						${!useNamedCommand ? html`
							<input class="wf-input ${errs.run ? "wf-input-error" : ""}" data-testid="wf-step-run" .value=${step.run || ""} placeholder="Command to run..."
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ run: (e.target as HTMLInputElement).value })} />
							${readOnly ? nothing : html`<div class="wf-field-hint">Variables: {{branch}}, {{master}}, {{cwd}}, {{project.key}}, {{agent.key}}, {{gate_id.meta.key}}</div>`}
							${errs.run ? html`<div class="wf-field-error" data-testid="wf-step-run-error">${errs.run}</div>` : nothing}
						` : html`
							<input class="wf-input ${errs.command ? "wf-input-error" : ""}" data-testid="wf-step-command" .value=${step.command || ""} placeholder="Named command (e.g. build, unit)"
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => updateStep({ command: (e.target as HTMLInputElement).value })} />
							<div class="wf-field-hint">Resolves against the chosen component's <code>commands:</code> map.</div>
							${errs.command ? html`<div class="wf-field-error" data-testid="wf-step-command-error">${errs.command}</div>` : nothing}
						`}
					` : html`
						<textarea class="wf-textarea ${errs.prompt ? "wf-input-error" : ""}" data-testid="wf-step-prompt" .value=${step.prompt || ""} placeholder="${stepType === "agent-qa" ? "QA test prompt..." : stepType === "human-signoff" ? "What to ask the reviewer…" : "Review prompt..."}"
							?readonly=${readOnly}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => updateStep({ prompt: (e.target as HTMLTextAreaElement).value })}></textarea>
						${errs.prompt ? html`<div class="wf-field-error" data-testid="wf-step-prompt-error">${errs.prompt}</div>` : nothing}
					`}

					${stepType === "human-signoff" ? html`
						<div class="wf-field">
							<label class="wf-field-label">Card Title</label>
							<input class="wf-input ${errs.label ? "wf-input-error" : ""}" data-testid="wf-step-label" .value=${step.label || ""} placeholder="Approve design doc"
								?disabled=${readOnly}
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
									?disabled=${readOnly}
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
										?disabled=${readOnly}
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
										?disabled=${readOnly}
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
											?disabled=${readOnly}
											@click=${(e: Event) => e.stopPropagation()}
											@change=${(e: Event) => updateStep({ component: (e.target as HTMLSelectElement).value || undefined })}>
											<option value="" ?selected=${!step.component}>(first component)</option>
											${componentOptions.map(n => html`<option value="${n}" ?selected=${step.component === n}>${n}</option>`)}
										</select>
									` : html`
										<input class="wf-input ${errs.component ? "wf-input-error" : ""}" data-testid="wf-step-component" .value=${step.component || ""} placeholder="Component name"
											?disabled=${readOnly}
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
									?readonly=${readOnly}
									@click=${(e: Event) => e.stopPropagation()}
									@input=${(e: Event) => updateStep({ description: (e.target as HTMLTextAreaElement).value || undefined })}></textarea>
							</div>
						</div>
					</details>

					<div class="wf-vstep-optional-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" data-testid="wf-step-optional" .checked=${step.optional === true}
								?disabled=${readOnly}
								@click=${(e: Event) => e.stopPropagation()}
								@change=${(e: Event) => {
									const checked = (e.target as HTMLInputElement).checked;
									const steps = currentSteps();
									steps[stepIdx] = { ...steps[stepIdx], optional: checked || undefined };
									if (!checked) {
										delete steps[stepIdx].optional;
										delete steps[stepIdx].optionalLabel;
									}
									updateGateField(inst, gateIdx, "verify", steps);
								}} />
							<span>Optional</span>
							<span class="wf-info-icon" title="User opts in at goal-creation time">i</span>
						</label>
						${step.optional ? html`
							<input class="wf-input" data-testid="wf-step-optional-label" style="flex:1;" .value=${step.optionalLabel || ""} placeholder="Toggle label (e.g. Enable QA Testing)"
								?disabled=${readOnly}
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
// OPEN PROJECT ASSISTANT
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
		const title = pageInstance.isNew ? "New Workflow" : pageInstance.selectedWorkflow?.name || "Edit";
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
						onClick: () => pageInstance.selectedWorkflow ? handleDelete(pageInstance.selectedWorkflow) : showList(),
						className: "wf-nav-delete",
						children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} Delete</span>`,
					})}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: pageInstance.saving || (!pageInstance.editId.trim() && pageInstance.isNew) || !pageInstance.editName.trim(),
						children: pageInstance.saving ? "Saving\u2026" : "Save",
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
//
// Each exported renderer operates on its own `EditorInstance` keyed by
// `workflowKey`. The page module-level state (`pageInstance`,
// `currentView`, `workflows`, `loading`) is NEVER touched by these
// renderers, so opening the proposal modal while the Workflows page edit
// view is mounted leaves the page's draft, expansion state, and drag
// state untouched.
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
 * and by the goal-proposal modal's Workflow tab.
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
 * Seed an embed instance from a workflow when its identity changes. Keeps
 * expansion / draft state across re-renders when the same workflow is
 * shown again.
 */
function seedEmbedInstance(
	inst: EditorInstance,
	wf: Workflow,
	controller: EditorController,
	expandAll: boolean,
): void {
	const sameWorkflow = inst.controller?.workflowKey === controller.workflowKey
		&& inst.editId === wf.id
		&& inst.controller?.readOnly === controller.readOnly;
	inst.controller = controller;
	if (sameWorkflow) return;
	inst.selectedWorkflow = null;
	inst.isNew = !wf.id;
	inst.editId = wf.id;
	inst.editName = wf.name;
	inst.editDescription = wf.description;
	inst.editGates = (wf.gates || []).map((g) => ({
		...g,
		dependsOn: [...(g.dependsOn || [])],
		verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
		metadata: g.metadata ? { ...g.metadata } : undefined,
	}));
	inst.expandedGateIndices = expandAll
		? new Set<number>(inst.editGates.map((_, i) => i))
		: new Set();
	inst.expandedVStepKeys = new Set();
	if (expandAll) {
		inst.editGates.forEach((g, gi) => {
			(g.verify || []).forEach((_, si) => inst.expandedVStepKeys.add(`${gi}-${si}`));
		});
	}
	inst.dragIndex = null;
	inst.dropTargetIndex = null;
	inst.vstepDragGateIdx = null;
	inst.vstepDragStepIdx = null;
	inst.vstepDropTarget = null;
	inst.emptyPhases = new Map();
}

/**
 * Stateless, read-only workflow inspector. Each `workflow.id` gets its own
 * isolated `EditorInstance` (keyed by `__inspector__:<id>`). Page module
 * state is NEVER mutated.
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
	const workflowKey = `__inspector__:${wf.id}`;
	const inst = getOrCreateEmbedInstance(workflowKey);
	// Default to collapsed gates (expandAll=false) — the inspector is shown in
	// the goal-proposal Workflow tab where a compact overview is preferred; the
	// user expands individual gates on demand.
	seedEmbedInstance(inst, wf, { scope, workflowKey, onChange: () => {}, readOnly: true }, false);
	return renderEditView(inst);
}

/**
 * Stateless workflow editor. Each `workflow.id` gets its own isolated
 * `EditorInstance` keyed by `__editor__:<id>`. Page module state is NEVER
 * mutated; every mutation flows through `opts.onChange`.
 */
export function renderWorkflowEditor(opts: {
	workflow: Workflow;
	onChange: (wf: Workflow) => void;
	scope?: EditorScope;
}): TemplateResult {
	const scope: EditorScope = opts.scope ?? "goal-draft";
	const workflowKey = `__editor__:${opts.workflow.id || "__draft__"}`;
	const inst = getOrCreateEmbedInstance(workflowKey);
	seedEmbedInstance(inst, opts.workflow, { scope, workflowKey, onChange: opts.onChange, readOnly: false }, false);
	return renderEditView(inst);
}

/**
 * Drop any cached embed editor/inspector state. Embeds should call this
 * when they unmount so subsequent renders start fresh.
 */
export function clearWorkflowEditorController(): void {
	embedInstances.clear();
}

function renderListView(): TemplateResult {
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

function renderPhaseGroups(inst: EditorInstance, gate: WorkflowGate, gateIdx: number): TemplateResult {
	const readOnly = isReadOnly(inst);
	const steps = gate.verify || [];
	const grouped = groupStepsByPhase(steps);
	const allPhases = getAllPhaseNumbers(inst, gateIdx);

	if (allPhases.length === 0 && steps.length === 0) {
		if (readOnly) {
			return html`<div class="wf-phase-group" data-phase="0"><div class="wf-phase-body wf-phase-empty-hint">No verification steps</div></div>`;
		}
		return html`
			<div class="wf-phase-group" data-gate-idx="${gateIdx}" data-phase="0"
				@dragover=${(e: DragEvent) => handleVStepDragOver(inst, e, 0, 0)}
				@drop=${(e: DragEvent) => handleVStepDrop(inst, e)}>
				<div class="wf-phase-header"><span>Phase 0</span></div>
				<div class="wf-phase-body wf-phase-empty-hint">No steps</div>
			</div>
		`;
	}

	return html`${allPhases.map(phase => {
		const phaseSteps = grouped.get(phase) || [];
		const isEmpty = phaseSteps.length === 0;
		const isEmptyTracked = inst.emptyPhases.get(gateIdx)?.has(phase) ?? false;
		return html`
			<div class="wf-phase-group" data-gate-idx="${gateIdx}" data-phase="${phase}"
				@dragover=${readOnly ? undefined : (e: DragEvent) => {
					if (isEmpty) handleVStepDragOver(inst, e, phase, 0);
				}}
				@drop=${readOnly ? undefined : (e: DragEvent) => handleVStepDrop(inst, e)}>
				<div class="wf-phase-header">
					<span>Phase ${phase}</span>
					${!readOnly && isEmpty && isEmptyTracked ? html`
						<button class="wf-phase-delete" title="Remove empty phase" @click=${(e: Event) => {
							e.stopPropagation();
							removeEmptyPhase(inst, gateIdx, phase);
						}}>${icon(Trash2, "sm")}</button>
					` : nothing}
				</div>
				<div class="wf-phase-body">
					${phaseSteps.length === 0 && !readOnly ? html`<div class="wf-phase-empty-hint">No steps — drag here or add one</div>` : nothing}
					${phaseSteps.map((entry, posInPhase) => html`
						${!readOnly && inst.vstepDropTarget && inst.vstepDropTarget.phase === phase && inst.vstepDropTarget.position === posInPhase && inst.vstepDragGateIdx === gateIdx
							? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
						<div
							@dragover=${readOnly ? undefined : (e: DragEvent) => {
								const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
								const midY = rect.top + rect.height / 2;
								const pos = e.clientY < midY ? posInPhase : posInPhase + 1;
								handleVStepDragOver(inst, e, phase, pos);
							}}>
							${renderVerifyStepEditor(inst, gate, gateIdx, entry.step, entry.originalIndex)}
						</div>
					`)}
					${!readOnly && inst.vstepDropTarget && inst.vstepDropTarget.phase === phase && inst.vstepDropTarget.position >= phaseSteps.length && inst.vstepDragGateIdx === gateIdx
						? html`<div class="wf-vstep-drop-indicator"></div>` : nothing}
				</div>
			</div>
		`;
	})}`;
}

// ============================================================================
// RENDER: DEPENDS-ON CHIP STRIP
// ============================================================================

function renderDependsOnEditor(inst: EditorInstance, gate: WorkflowGate, idx: number): TemplateResult {
	const others = inst.editGates
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
								updateGateField(inst, idx, "dependsOn", [...next]);
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
function commitMetadataRows(inst: EditorInstance, idx: number, rows: Array<[string, string]>, rerender = false): void {
	metadataDrafts.set(idx, rows);
	const rec: Record<string, string> = {};
	for (const [k, v] of rows) {
		const trimmed = k.trim();
		if (trimmed) rec[trimmed] = v;
	}
	const nextGates = [...inst.editGates];
	const nextGate = { ...nextGates[idx], metadata: Object.keys(rec).length > 0 ? rec : undefined };
	nextGates[idx] = nextGate;
	inst.editGates = nextGates;
	notifyControlledChange(inst);
	if (rerender) renderApp();
}

function renderMetadataEditor(inst: EditorInstance, gate: WorkflowGate, idx: number): TemplateResult {
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
								commitMetadataRows(inst, idx, next);
							}} />
						<input class="wf-input" data-testid="wf-metadata-value" placeholder="value" .value=${v}
							@click=${(e: Event) => e.stopPropagation()}
							@input=${(e: Event) => {
								const currentRows = metadataDrafts.get(idx) || rows!;
								const next: Array<[string, string]> = currentRows.map((p, i) => i === rowIdx ? [p[0], (e.target as HTMLInputElement).value] : p);
								commitMetadataRows(inst, idx, next);
							}} />
						<button class="wf-criteria-remove" title="Remove metadata entry" data-testid="wf-metadata-remove" @click=${(e: Event) => {
							e.stopPropagation();
							const currentRows = metadataDrafts.get(idx) || rows!;
							const next: Array<[string, string]> = currentRows.filter((_, i) => i !== rowIdx);
							commitMetadataRows(inst, idx, next, true);
						}}>${icon(Trash2, "sm")}</button>
					</div>
				`)}
			</div>
			<button class="wf-criteria-add-btn" data-testid="wf-metadata-add" @click=${(e: Event) => {
				e.stopPropagation();
				const currentRows = metadataDrafts.get(idx) || rows || [];
				const next: Array<[string, string]> = [...currentRows, ["", ""]];
				commitMetadataRows(inst, idx, next, true);
			}}>Add metadata</button>
			<div class="wf-field-hint">Free-form key/value pairs (used by some workflows for routing).</div>
		</div>
	`;
}

// ============================================================================
// RENDER: GATE EDITOR (collapsible card)
// ============================================================================

function renderGateEditor(inst: EditorInstance, gate: WorkflowGate, idx: number): TemplateResult {
	const readOnly = isReadOnly(inst);
	const isExpanded = inst.expandedGateIndices.has(idx);
	const isDragging = inst.dragIndex === idx;
	const verifySummary = getVerifySummary(gate);
	const verifyCount = (gate.verify || []).length;
	const gateClasses = [
		"wf-gate-card",
		isExpanded ? "expanded" : "",
		isDragging ? "dragging" : "",
		readOnly ? "wf-gate-readonly" : "",
	].filter(Boolean).join(" ");

	return html`
		${inst.dropTargetIndex === idx && inst.dragIndex !== null && inst.dragIndex !== idx ? html`<div class="wf-drop-indicator"></div>` : nothing}
		<div class=${gateClasses} data-gate-id=${gate.id}>
			<div class="wf-gate-header"
				draggable=${readOnly ? "false" : "true"}
				@dragstart=${readOnly ? undefined : (e: DragEvent) => handleDragStart(inst, e, idx)}
				@dragover=${readOnly ? undefined : (e: DragEvent) => handleDragOver(inst, e, idx)}
				@drop=${readOnly ? undefined : (e: DragEvent) => handleDrop(inst, e)}
				@dragend=${readOnly ? undefined : () => handleDragEnd(inst)}
				@touchstart=${readOnly ? undefined : (e: TouchEvent) => handleHeaderTouchStart(inst, e, idx)}
				@touchmove=${readOnly ? undefined : (e: TouchEvent) => handleTouchMove(inst, e)}
				@touchend=${readOnly ? undefined : () => handleTouchEnd(inst)}
				@touchcancel=${readOnly ? undefined : () => cancelTouchDrag(inst)}
				@click=${() => toggleGateExpand(inst, idx)}>
				${readOnly ? nothing : html`<span class="wf-gate-grip"
					@touchstart=${(e: TouchEvent) => handleGripTouchStart(inst, e, idx)}>${icon(GripVertical, "sm")}</span>`}
				<span class="wf-gate-idx">${idx + 1}</span>
				<span class="wf-gate-chevron">\u25B8</span>
				<span class="wf-gate-name">${gate.name || "(unnamed)"}</span>
				${readOnly && gate.content ? html`<span class="wf-gate-pill">content</span>` : nothing}
				${readOnly && gate.injectDownstream ? html`<span class="wf-gate-pill">inject downstream</span>` : nothing}
				${verifySummary ? html`<span class="wf-gate-pill">${verifySummary}</span>` : nothing}
				${readOnly ? nothing : html`<button class="wf-gate-delete" @click=${(e: Event) => { e.stopPropagation(); removeGate(inst, idx); }} title="Remove gate">${icon(Trash2, "sm")}</button>`}
			</div>

			<div class="wf-gate-body">
				<div class="wf-gate-body-inner">
					<div class="wf-identity-row">
						<label class="wf-field-label">ID</label>
						<input class="wf-input" data-testid="wf-gate-id" style="width:140px;" .value=${gate.id} placeholder="e.g. issue-analysis"
							?disabled=${readOnly}
							@input=${(e: Event) => updateGateField(inst, idx, "id", (e.target as HTMLInputElement).value)} />
						<label class="wf-field-label" style="margin-left:8px;">Name</label>
						<input class="wf-input" data-testid="wf-gate-name" style="flex:1;min-width:0;" .value=${gate.name} placeholder="Display name"
							?disabled=${readOnly}
							@input=${(e: Event) => updateGateField(inst, idx, "name", (e.target as HTMLInputElement).value)} />
					</div>

					${readOnly && gate.dependsOn && gate.dependsOn.length > 0 ? html`
						<div class="wf-identity-row">
							<label class="wf-field-label">Depends on</label>
							<span class="wf-inspector-value">${gate.dependsOn.join(", ")}</span>
						</div>
					` : nothing}

					${readOnly ? nothing : html`<div class="wf-toggles-row">
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-content" .checked=${gate.content === true}
								@change=${(e: Event) => updateGateField(inst, idx, "content", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Content</span>
							<span class="wf-info-icon" title="Content gates store a markdown document">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-inject-downstream" .checked=${gate.injectDownstream === true}
								@change=${(e: Event) => updateGateField(inst, idx, "injectDownstream", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Inject downstream</span>
							<span class="wf-info-icon" title="Agents working towards subsequent gates have the content attached to this gate injected into their context">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-optional" .checked=${gate.optional === true}
								@change=${(e: Event) => updateGateField(inst, idx, "optional", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Optional</span>
							<span class="wf-info-icon" title="Whole gate is skippable for the goal">i</span>
						</label>
						<label class="wf-toggle-compact">
							<input type="checkbox" class="toggle-switch" data-testid="wf-gate-manual" .checked=${gate.manual === true}
								@change=${(e: Event) => updateGateField(inst, idx, "manual", (e.target as HTMLInputElement).checked || undefined)} />
							<span>Manual</span>
							<span class="wf-info-icon" title="Don't auto-verify on signal; require an explicit human signal. (Different from a human-signoff step type — manual gates have no per-step approval UI.)">i</span>
						</label>
					</div>`}

					${renderDependsOnEditor(inst, gate, idx)}

					${renderMetadataEditor(inst, gate, idx)}

					<div class="wf-field">
						<span class="wf-verify-label">Verification Steps (${verifyCount})</span>
						<div class="wf-verification-steps">
							${renderPhaseGroups(inst, gate, idx)}
							${readOnly ? nothing : html`<div class="wf-phase-actions">
								<button class="wf-criteria-add-btn" title="Add verification step" @click=${(e: Event) => {
									e.stopPropagation();
									const steps = [...(gate.verify || []), { name: "", type: "command" as const, run: "" }];
									updateGateField(inst, idx, "verify", steps);
								}}>Add Step</button>
								<button class="wf-criteria-add-btn wf-add-phase-btn" title="Add a new phase" @click=${(e: Event) => {
									e.stopPropagation();
									addPhase(inst, idx);
								}}>Add Phase</button>
							</div>`}
						</div>
					</div>
				</div>
			</div>
		</div>
		${inst.dropTargetIndex === inst.editGates.length && idx === inst.editGates.length - 1 && inst.dragIndex !== null ? html`<div class="wf-drop-indicator"></div>` : nothing}
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function autoGrowTextarea(el: HTMLTextAreaElement): void {
	el.style.height = '0';
	el.style.height = Math.max(32, el.scrollHeight) + 'px';
}

function renderEditView(inst: EditorInstance): TemplateResult {
	const controlled = inst.controller !== null;
	const readOnly = isReadOnly(inst);
	const containerClasses = readOnly
		? "wf-edit-container wf-container-embedded wf-inspector"
		: "wf-edit-container";
	const testId = readOnly ? "workflow-inspector" : "workflow-editor";
	return html`
		<div class=${containerClasses}
			data-testid=${testId}
			data-scope=${inst.controller?.scope ?? "project"}
			data-workflow-id=${inst.editId}>
			${saveBlockedReason ? html`
				<div class="wf-save-error-banner" data-testid="wf-save-error-banner" role="alert">
					${icon(AlertCircle, "sm")}
					<span>${saveBlockedReason}</span>
				</div>
			` : nothing}
			<div class="wf-edit-identity">
				${controlled ? nothing : html`
					<div class="flex items-center justify-between mb-1">
						<span>${inst.selectedWorkflow ? renderOriginBadge((inst.selectedWorkflow as any).origin, (inst.selectedWorkflow as any).overrides) : ""}</span>
						${renderCustomizeRevertButtons()}
					</div>
				`}
				<div class="wf-identity-row">
					<label class="wf-field-label">ID</label>
					${inst.isNew && !readOnly ? html`
						<input class="wf-input" style="width:140px;" .value=${inst.editId} placeholder="e.g. bug-fix"
							@input=${(e: Event) => { inst.editId = (e.target as HTMLInputElement).value; notifyControlledChange(inst); renderApp(); }} />
					` : html`
						<input class="wf-input" style="width:140px;opacity:0.6;cursor:not-allowed;" .value=${inst.editId} disabled />
					`}
					<label class="wf-field-label" style="margin-left:8px;">Name</label>
					<input class="wf-input" style="flex:1;min-width:0;" .value=${inst.editName} placeholder="Workflow name"
						?disabled=${readOnly}
						@input=${(e: Event) => { inst.editName = (e.target as HTMLInputElement).value; notifyControlledChange(inst); renderApp(); }} />
				</div>
				<div class="wf-identity-row">
					<label class="wf-field-label" style="flex-shrink:0;">Description</label>
					<textarea class="wf-textarea wf-desc-auto" rows="1" .value=${inst.editDescription} placeholder="What this workflow does"
						?readonly=${readOnly}
						@input=${(e: Event) => { inst.editDescription = (e.target as HTMLTextAreaElement).value; notifyControlledChange(inst); autoGrowTextarea(e.target as HTMLTextAreaElement); }}></textarea>
				</div>
			</div>

			<div class="wf-artifacts-list">
				${inst.editGates.map((gate, idx) => renderGateEditor(inst, gate, idx))}
				${inst.editGates.length === 0 && readOnly ? html`<div class="wf-empty"><p class="wf-empty-desc">This workflow has no gates.</p></div>` : nothing}
				${readOnly ? nothing : Button({
					variant: "secondary" as any,
					size: "sm",
					className: "wf-add-gate-btn",
					onClick: () => addGate(inst),
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
	if (!pageInstance.selectedWorkflow || pageInstance.isNew) return "";
	const origin = (pageInstance.selectedWorkflow as any).origin as ConfigOrigin | undefined;
	if (origin !== "project") return "";
	const projectId = getConfigProjectId();
	return html`<button class="config-action-btn config-action-btn--revert" @click=${async () => {
		if (await revertOverride("workflows", pageInstance.selectedWorkflow!.id, "project", projectId)) {
			workflows = await fetchWorkflowsScoped();
			const updated = workflows.find(w => w.id === pageInstance.selectedWorkflow!.id);
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
				${currentView === "list" ? renderListView() : renderEditView(pageInstance)}
			</div>
		</div>
	`;
}

// ============================================================================
// TEST HOOKS — read-only snapshots of internal state for regression tests.
// These intentionally surface enough of the page editor state to assert
// non-clobbering when the modal renders its own editor/inspector. Not
// part of any public UI contract.
// ============================================================================
export const __test = {
	pageInstanceSnapshot() {
		return {
			editId: pageInstance.editId,
			editName: pageInstance.editName,
			editDescription: pageInstance.editDescription,
			gateCount: pageInstance.editGates.length,
			gateIds: pageInstance.editGates.map((g) => g.id),
			selectedWorkflowId: pageInstance.selectedWorkflow?.id ?? null,
			controller: pageInstance.controller,
			expandedGateIndices: [...pageInstance.expandedGateIndices],
		};
	},
	hasEmbedInstance(workflowKey: string): boolean {
		return embedInstances.has(workflowKey);
	},
	embedInstanceCount(): number {
		return embedInstances.size;
	},
};
