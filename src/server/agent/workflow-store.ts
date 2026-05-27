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

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "human-signoff";
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
	const step: VerifyStep = {
		name: typeof r.name === "string" ? r.name : "",
		type: (r.type === "llm-review" || r.type === "agent-qa" || r.type === "human-signoff") ? r.type : "command",
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
	return step;
}

function normalizeGate(raw: unknown): WorkflowGate {
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

function normalizeWorkflow(raw: unknown, idHint: string): Workflow | null {
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
