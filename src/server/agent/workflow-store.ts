/**
 * Inline-workflow store — replaces the on-disk `workflows/<id>.yaml` layer.
 *
 * See docs/design/multi-repo-components.md §3.2.
 *
 * Workflows now live inline in `project.yaml::workflows`. This store is a
 * thin facade over `ProjectConfigStore` that exposes the same API the
 * legacy `WorkflowStore` did (so `WorkflowManager`, `ConfigCascade`, and
 * `goal-manager` can keep calling `get / getAll / put / remove / update`
 * without changes), but the underlying data source is the inline block.
 *
 * The class is exported under both names (`WorkflowStore` and
 * `InlineWorkflowStore`) for back-compat with existing imports.
 */

import type { ProjectConfigStore, InlineWorkflowDef, InlineWorkflowGate, InlineVerifyStep } from "./project-config-store.js";

// ── Public types (kept compatible with the old WorkflowStore shape) ──

/**
 * Subgoal verify-step descriptor (only meaningful when `VerifyStep.type === "subgoal"`).
 *
 * Phase 3 of nested goals — see docs/_phase-3-notes.md and SUBGOALS-SPEC §2.
 *
 * The verification harness's `runSubgoalStep` handler reads these fields to
 * spawn / resolve a child goal and waits for the child's `ready-to-merge`
 * gate before merging the child branch into the parent.
 */
export interface VerifyStepSubgoal {
	/** Stable id for this plan node — used as the spawnedFromPlanId on the child goal (Lesson 4.1). */
	planId: string;
	/** Title of the subgoal — becomes the child goal's title. */
	title: string;
	/** Markdown spec for the subgoal — becomes the child goal's spec. */
	spec: string;
	/** Workflow id for the child (defaults to "feature" when omitted). */
	workflowId?: string;
	/** Suggested team-lead role for the child. */
	suggestedRole?: string;
	/**
	 * Sibling planIds this step depends on (Phase 5 — explicit DAG).
	 * Empty/undefined means parallel sibling at column 0. Used by the
	 * Plan-tab synthesis layer to compute topological depth + which edges
	 * to draw between plan nodes. Validated by
	 * `depends-on-validation.ts::validatePlanDependsOn` at PATCH /plan time.
	 */
	dependsOn?: string[];
}

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "subgoal";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
	phase?: number;
	optional?: boolean;
	label?: string;
	role?: string;
	description?: string;
	/** Structural reference: which component to run from (Phase 2). */
	component?: string;
	/** Structural reference: which command on that component to invoke (Phase 2). */
	command?: string;
	/** Subgoal step descriptor (only when type === "subgoal"). */
	subgoal?: VerifyStepSubgoal;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	optional?: boolean;
	manual?: boolean;
	metadata?: Record<string, string>;
	verify?: VerifyStep[];
}

export interface Workflow {
	id: string;
	name: string;
	description: string;
	gates: WorkflowGate[];
	createdAt: number;
	updatedAt: number;
	/** If true, workflow is hidden from the UI (e.g. test-only workflows) */
	hidden?: boolean;
}

// ── Normalization between the inline yaml shape and the runtime shape ──

function normalizeStep(raw: unknown): VerifyStep {
	const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
	const rawType = r.type;
	const type: VerifyStep["type"] =
		rawType === "llm-review" || rawType === "agent-qa" || rawType === "subgoal"
			? rawType
			: "command";
	const step: VerifyStep = {
		name: typeof r.name === "string" ? r.name : "",
		type,
	};
	if (typeof r.run === "string") step.run = r.run;
	if (typeof r.prompt === "string") step.prompt = r.prompt;
	if (r.expect === "success" || r.expect === "failure") step.expect = r.expect;
	if (typeof r.timeout === "number") step.timeout = r.timeout;
	if (typeof r.phase === "number") step.phase = r.phase;
	if (r.optional === true) step.optional = true;
	if (typeof r.label === "string") step.label = r.label;
	if (typeof r.role === "string") step.role = r.role;
	if (typeof r.description === "string") step.description = r.description;
	if (typeof r.component === "string") step.component = r.component;
	if (typeof r.command === "string") step.command = r.command;
	// Subgoal payload — only round-tripped when the field is a structured
	// object. Older stored data without the `subgoal` field is silently
	// tolerated; non-subgoal step types may legitimately leave this unset.
	if (r.subgoal && typeof r.subgoal === "object" && !Array.isArray(r.subgoal)) {
		const sg = r.subgoal as Record<string, unknown>;
		const planId = typeof sg.planId === "string" ? sg.planId : (typeof sg.plan_id === "string" ? sg.plan_id : "");
		const title = typeof sg.title === "string" ? sg.title : "";
		const spec = typeof sg.spec === "string" ? sg.spec : "";
		const workflowId = typeof sg.workflowId === "string" ? sg.workflowId
			: typeof sg.workflow_id === "string" ? sg.workflow_id : undefined;
		const suggestedRole = typeof sg.suggestedRole === "string" ? sg.suggestedRole
			: typeof sg.suggested_role === "string" ? sg.suggested_role : undefined;
		const dependsOnRaw = Array.isArray(sg.dependsOn) ? sg.dependsOn
			: Array.isArray(sg.depends_on) ? sg.depends_on : undefined;
		const dependsOn = dependsOnRaw
			? dependsOnRaw.filter((d): d is string => typeof d === "string")
			: undefined;
		const subgoal: VerifyStepSubgoal = { planId, title, spec };
		if (workflowId !== undefined) subgoal.workflowId = workflowId;
		if (suggestedRole !== undefined) subgoal.suggestedRole = suggestedRole;
		if (dependsOn !== undefined) subgoal.dependsOn = dependsOn;
		step.subgoal = subgoal;
	}
	return step;
}

export function normalizeGate(raw: unknown): WorkflowGate {
	const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
	const gate: WorkflowGate = {
		id: typeof r.id === "string" ? r.id : "",
		name: typeof r.name === "string" ? r.name : "",
		dependsOn: Array.isArray(r.depends_on) ? r.depends_on as string[]
			: Array.isArray(r.dependsOn) ? r.dependsOn as string[]
			: [],
	};
	if (r.content === true) gate.content = true;
	if (r.inject_downstream === true || r.injectDownstream === true) gate.injectDownstream = true;
	if (r.optional === true) gate.optional = true;
	if (r.manual === true) gate.manual = true;
	if (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)) {
		gate.metadata = r.metadata as Record<string, string>;
	}
	if (Array.isArray(r.verify)) {
		gate.verify = r.verify.map(normalizeStep);
	}
	return gate;
}

/**
 * Detect whether a workflow is the `parent` meta-workflow — the one whose
 * `execution` gate drives subgoal verify-steps. Used to decide whether a
 * child inheriting the parent's workflow snapshot should strip the
 * parent-specific subgoal entries from `execution.verify[]` (see
 * `stripSubgoalStepsForChildInheritance`). Children still inherit the
 * workflow's structural scaffold — gates, dependencies, synthesis /
 * ready-to-merge / etc. — just not the parent's plan items.
 *
 * Detection is conservative: either the id is `"parent"` OR the execution
 * gate contains at least one `verify[]` entry with `type === "subgoal"`.
 * Either signal is sufficient — we treat the workflow as a meta-workflow.
 */
export function isParentMetaWorkflow(wf: Workflow | undefined | null): boolean {
	if (!wf) return false;
	if (wf.id === "parent") return true;
	const exec = wf.gates.find(g => g.id === "execution");
	if (!exec || !Array.isArray(exec.verify)) return false;
	return exec.verify.some(v => v?.type === "subgoal");
}

/**
 * Prepare a parent meta-workflow snapshot for inheritance by a child goal.
 *
 * For a meta-workflow (`isParentMetaWorkflow`), produces a child-scoped clone:
 *
 * 1. **Strip subgoal entries from `execution.verify[]`** — the parent's plan
 *    items don't belong on the child.
 * 2. **Drop aggregation gates** — any gate strictly between `execution` and
 *    `ready-to-merge` in the DAG (transitively downstream of `execution` AND
 *    upstream of `ready-to-merge`) is parent-scoped by construction: those
 *    gates aggregate across children (e.g. "all 5 sibling artefacts exist",
 *    "synthesis review of memory-synthesized.md"). A child goal can never
 *    satisfy them; inheriting would deadlock the child on `ready-to-merge`.
 * 3. **Rewire `ready-to-merge`** to depend directly on `execution`, since the
 *    intermediate aggregation gates no longer exist.
 *
 * Upstream gates (charter, plan-review, goal-plan — everything that
 * `execution` transitively depends on) ARE preserved. A child's team-lead
 * writes its own charter/plan/etc. for its own scope; those gates make sense
 * at both levels. Gates outside the execution→ready-to-merge branch entirely
 * (optional side-gates) are preserved.
 *
 * For non-meta workflows this is a pure deep-clone — nothing is altered.
 * Callers should gate on `isParentMetaWorkflow` when they want to avoid the
 * clone for non-inheritance paths; this helper is safe to call either way.
 */
export function stripSubgoalStepsForChildInheritance(wf: Workflow): Workflow {
	const clone = JSON.parse(JSON.stringify(wf)) as Workflow;
	if (!isParentMetaWorkflow(clone)) return clone;

	// 1. Strip parent-specific subgoal entries from execution.verify[].
	const exec = clone.gates.find(g => g.id === "execution");
	if (exec && Array.isArray(exec.verify)) {
		exec.verify = exec.verify.filter(v => v?.type !== "subgoal");
	}
	if (!exec) return clone; // defensive — isParentMetaWorkflow guarantees exec

	// 2. Identify aggregation gates: strictly downstream of `execution` AND
	//    strictly upstream of `ready-to-merge`. BFS on dependencies both
	//    directions.
	const byId = new Map(clone.gates.map(g => [g.id, g]));
	const rtm = clone.gates.find(g => g.id === "ready-to-merge");

	// transitively-downstream-of-execution: reverse-DAG BFS from execution
	// following "X depends on Y" → X is downstream of Y.
	const downstreamOfExec = new Set<string>();
	const queue: string[] = [];
	for (const g of clone.gates) {
		if (Array.isArray(g.dependsOn) && g.dependsOn.includes("execution")) {
			downstreamOfExec.add(g.id);
			queue.push(g.id);
		}
	}
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const g of clone.gates) {
			if (downstreamOfExec.has(g.id)) continue;
			if (Array.isArray(g.dependsOn) && g.dependsOn.includes(id)) {
				downstreamOfExec.add(g.id);
				queue.push(g.id);
			}
		}
	}

	// transitively-upstream-of-rtm: forward-DAG BFS from ready-to-merge.
	const upstreamOfRtm = new Set<string>();
	if (rtm) {
		const q2: string[] = [...(rtm.dependsOn ?? [])];
		for (const d of q2) upstreamOfRtm.add(d);
		while (q2.length > 0) {
			const id = q2.shift()!;
			const g = byId.get(id);
			if (!g) continue;
			for (const d of (g.dependsOn ?? [])) {
				if (!upstreamOfRtm.has(d)) {
					upstreamOfRtm.add(d);
					q2.push(d);
				}
			}
		}
	}

	// Aggregation = downstream-of-exec ∩ upstream-of-rtm, excluding exec/rtm themselves.
	const aggregationGateIds = new Set<string>();
	for (const id of downstreamOfExec) {
		if (id === "execution" || id === "ready-to-merge") continue;
		if (rtm && upstreamOfRtm.has(id)) aggregationGateIds.add(id);
	}

	if (aggregationGateIds.size > 0) {
		// 3. Drop aggregation gates.
		clone.gates = clone.gates.filter(g => !aggregationGateIds.has(g.id));
		// 3b. Rewire ready-to-merge to depend directly on execution (it was
		// previously depending on the now-removed aggregation gates).
		const rtmClone = clone.gates.find(g => g.id === "ready-to-merge");
		if (rtmClone) {
			const kept = (rtmClone.dependsOn ?? []).filter(id => !aggregationGateIds.has(id));
			// Ensure execution is in the dependency list (the aggregation
			// gates were the only bridge between exec and rtm in the DAG).
			if (!kept.includes("execution")) kept.push("execution");
			rtmClone.dependsOn = kept;
		}
		// 3c. Any other gate that depended on a removed aggregation gate
		// gets its reference pruned (defensive — shouldn't happen in
		// well-formed meta-workflows but don't leave dangling refs).
		for (const g of clone.gates) {
			if (!Array.isArray(g.dependsOn)) continue;
			g.dependsOn = g.dependsOn.filter(id => !aggregationGateIds.has(id));
		}
	}

	return clone;
}

export function normalizeWorkflow(raw: unknown, idHint: string): Workflow | null {
	const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : null;
	if (!r) return null;
	const id = typeof r.id === "string" && r.id ? r.id : idHint;
	if (!id) return null;
	const gates = Array.isArray(r.gates) ? r.gates.map(normalizeGate) : [];
	const wf: Workflow = {
		id,
		name: typeof r.name === "string" ? r.name : id,
		description: typeof r.description === "string" ? r.description : "",
		gates,
		createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
	};
	if (r.hidden === true) wf.hidden = true;
	return wf;
}

function serializeStep(s: VerifyStep): Record<string, unknown> {
	const out: Record<string, unknown> = { name: s.name, type: s.type };
	if (s.component !== undefined) out.component = s.component;
	if (s.command !== undefined) out.command = s.command;
	if (s.run !== undefined) out.run = s.run;
	if (s.prompt !== undefined) out.prompt = s.prompt;
	if (s.expect !== undefined) out.expect = s.expect;
	if (s.timeout !== undefined) out.timeout = s.timeout;
	if (s.phase !== undefined) out.phase = s.phase;
	if (s.optional) out.optional = true;
	if (s.label !== undefined) out.label = s.label;
	if (s.role !== undefined) out.role = s.role;
	if (s.description !== undefined) out.description = s.description;
	if (s.subgoal) {
		const sg: Record<string, unknown> = {
			planId: s.subgoal.planId,
			title: s.subgoal.title,
			spec: s.subgoal.spec,
		};
		if (s.subgoal.workflowId !== undefined) sg.workflowId = s.subgoal.workflowId;
		if (s.subgoal.suggestedRole !== undefined) sg.suggestedRole = s.subgoal.suggestedRole;
		if (s.subgoal.dependsOn !== undefined) sg.dependsOn = s.subgoal.dependsOn;
		out.subgoal = sg;
	}
	return out;
}

function serializeGate(g: WorkflowGate): Record<string, unknown> {
	const out: Record<string, unknown> = { id: g.id, name: g.name };
	if (g.content) out.content = true;
	if (g.injectDownstream) out.inject_downstream = true;
	if (g.optional) out.optional = true;
	if (g.manual) out.manual = true;
	if (g.dependsOn && g.dependsOn.length > 0) out.depends_on = g.dependsOn;
	if (g.metadata) out.metadata = g.metadata;
	if (g.verify && g.verify.length > 0) out.verify = g.verify.map(serializeStep);
	return out;
}

function serializeWorkflow(wf: Workflow): InlineWorkflowDef {
	// Cast through unknown — shapes are structurally compatible.
	return {
		id: wf.id,
		name: wf.name,
		description: wf.description,
		...(wf.hidden ? { hidden: true } : {}),
		gates: wf.gates.map(serializeGate) as unknown as InlineWorkflowGate[],
	} as unknown as InlineWorkflowDef & { gates: InlineWorkflowGate[] };
}

/**
 * Inline-workflow store.
 *
 * Source: `ProjectConfigStore::getWorkflows()`. Mutations go back through
 * `ProjectConfigStore::setWorkflows()` so everything persists to a single
 * `project.yaml` file.
 *
 * Builtins are held in-memory only and never written to disk; they serve
 * as the lowest-priority layer in the config cascade.
 */
export class InlineWorkflowStore {
	private builtins: Map<string, Workflow> = new Map();

	constructor(private readonly cfg: ProjectConfigStore) {}

	// ── Builtin cascade (in-memory only) ────────────────────────

	setBuiltins(items: Workflow[]): void {
		this.builtins = new Map(items.map(i => [i.id, i]));
	}

	// ── Read operations ─────────────────────────────────────────

	private readLocal(): Map<string, Workflow> {
		this.cfg.reload();
		const block = this.cfg.getWorkflows();
		const out = new Map<string, Workflow>();
		if (!block) return out;
		for (const [id, raw] of Object.entries(block)) {
			const wf = normalizeWorkflow(raw, id);
			if (wf) out.set(wf.id, wf);
		}
		return out;
	}

	get(key: string): Workflow | undefined {
		const local = this.readLocal();
		return local.get(key) ?? this.builtins.get(key);
	}

	getLocal(key: string): Workflow | undefined {
		return this.readLocal().get(key);
	}

	getAll(): Workflow[] {
		const local = this.readLocal();
		const merged = new Map(this.builtins);
		for (const [k, v] of local) merged.set(k, v);
		return [...merged.values()].filter(w => !w.hidden);
	}

	getAllLocal(): Workflow[] {
		return [...this.readLocal().values()].filter(w => !w.hidden);
	}

	// ── Write operations ────────────────────────────────────────

	put(workflow: Workflow): void {
		const block = this.cfg.getWorkflows() ?? {};
		block[workflow.id] = serializeWorkflow(workflow) as unknown as InlineWorkflowDef;
		this.cfg.setWorkflows(block);
	}

	remove(key: string): void {
		const block = this.cfg.getWorkflows();
		if (!block) return;
		if (key in block) {
			delete block[key];
			this.cfg.setWorkflows(block);
		}
	}

	update(key: string, updates: Partial<Omit<Workflow, "id" | "createdAt">>): boolean {
		const local = this.readLocal();
		let existing = local.get(key);
		if (!existing) {
			// Copy-on-write from builtins.
			const bi = this.builtins.get(key);
			if (!bi) return false;
			existing = { ...bi };
		}
		const merged: Workflow = {
			...existing,
			...updates,
			updatedAt: Date.now(),
		} as Workflow;
		this.put(merged);
		return true;
	}

	/** Shape-compatible reload hook — no-op since we read on every call. */
	reload(): void {
		// readLocal() reloads on every access; nothing to do here.
	}
}

/** @deprecated Use `InlineWorkflowStore` directly. Re-exported for back-compat. */
export const WorkflowStore = InlineWorkflowStore;
export type WorkflowStore = InlineWorkflowStore;

// Re-export for type-only consumers that only need the inline-step types.
export type { InlineVerifyStep };
